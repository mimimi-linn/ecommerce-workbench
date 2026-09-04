// Sync script for GitHub Actions
// Fetches Feishu data, processes it, and updates feishu-data-live.js
// No external dependencies - uses only Node.js built-in modules

const https = require('https');
const fs = require('fs');

const BASE_TOKEN = "Yc1vbUbGAaayxdspPnQc3pmjn5d";
const TABLES = {
  target_summary: { id: "tbl438GW0vARpaQI", name: "目标与达成汇总表" },
  daily_sales: { id: "tblHDDLJUm52B9rr", name: "观星台日销售数据" },
  weekly_sales: { id: "tblbryEfRCJ0iM4B", name: "观星台周销售数据" },
  core_links: { id: "tblzE439uGMx5MkN", name: "核心链接销售表" },
  link_registry: { id: "tbl0KMizpvaaFuft", name: "小组链接登记表" },
  inventory: { id: "tbl1HnZaiTgPJG1C", name: "商品库存在途数据表" }
};

function num(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/,/g, '').replace(/¥/g, '').replace(/%/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function normalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) {
    if (val.length === 1) {
      if (typeof val[0] === 'object' && val[0] !== null) {
        if (val[0].name) return val[0].name;
        if (val[0].text) return val[0].text;
      }
      return val[0];
    }
    return val.map(x => {
      if (typeof x === 'object' && x !== null) return x.name || x.text || String(x);
      return String(x);
    }).join(', ');
  }
  if (typeof val === 'object' && val !== null) {
    return val.text || val.name || JSON.stringify(val);
  }
  return val;
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchTableRecords(userToken, tableId, tableName) {
  const allRecords = [];
  let pageToken = '';

  while (true) {
    const params = new URLSearchParams({ page_size: '200' });
    if (pageToken) params.set('page_token', pageToken);

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records?${params}`;
    const data = await fetchJSON(url, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });

    if (data.code !== 0) {
      console.error(`  获取 ${tableName} 失败: ${data.msg} (code: ${data.code})`);
      if (data.code === 99991663 || data.code === 99991661 || data.code === 99991664) {
        throw new Error('TOKEN_EXPIRED: ' + data.msg);
      }
      break;
    }

    const items = data.data.items || [];
    for (const item of items) {
      const record = {};
      for (const [key, val] of Object.entries(item.fields)) {
        record[key] = normalizeValue(val);
      }
      record._record_id = item.record_id;
      allRecords.push(record);
    }

    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  console.log(`  ${tableName}: ${allRecords.length} 条记录`);
  return allRecords;
}

function processDashboard(dailyRecords) {
  const byOwner = {};
  const owners = new Set();

  for (const r of dailyRecords) {
    const owner = r['负责人'];
    if (!owner) continue;
    owners.add(owner);
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(r);
  }

  const dashboardByOwner = {};
  for (const owner of owners) {
    const records = byOwner[owner].sort((a, b) => {
      return String(b['数据日期'] || '').localeCompare(String(a['数据日期'] || ''));
    });
    if (records.length === 0) continue;

    const latest = records[0];
    const dataDate = String(latest['数据日期'] || '').substring(0, 10);

    const actualSales = num(latest['日销售额']);
    const actualProfit = num(latest['日毛利额']);
    const targetSales = num(latest['日目标销售额']);
    const achievementRate = targetSales > 0 ? (actualSales / targetSales * 100) : 0;
    const feeRatio = actualSales > 0 ? (actualProfit / actualSales * 100) : 0;

    const productMap = {};
    for (const r of records.slice(0, 7)) {
      const pname = r['商品名称'];
      if (!pname) continue;
      if (!productMap[pname]) productMap[pname] = { name: pname, sales: 0, amount: 0, barcode: r['货品条码'] || '' };
      productMap[pname].sales += num(r['日销量']);
      productMap[pname].amount += num(r['日销售额']);
    }
    const top5 = Object.values(productMap).sort((a, b) => b.sales - a.sales).slice(0, 5);

    dashboardByOwner[owner] = {
      data_date: dataDate,
      actual_sales: Math.round(actualSales),
      actual_profit: Math.round(actualProfit),
      target_sales: Math.round(targetSales),
      achievement_rate: Math.round(achievementRate * 10) / 10,
      fee_ratio: Math.round(feeRatio * 10) / 10,
      top5_products: top5,
      total_orders: num(latest['日订单量']),
      total_visitors: num(latest['日访客数']),
      conversion_rate: num(latest['日支付转化率'])
    };
  }

  const firstOwner = Array.from(owners)[0];
  return {
    dashboard: dashboardByOwner[firstOwner] || { data_date: '--', actual_sales: 0, actual_profit: 0, target_sales: 0, achievement_rate: 0, fee_ratio: 0, top5_products: [], total_orders: 0, total_visitors: 0, conversion_rate: 0 },
    dashboard_by_owner: dashboardByOwner,
    trend_7d: dashboardByOwner[firstOwner] ? {
      days: byOwner[firstOwner].slice(0, 7).reverse().map(r => String(r['数据日期'] || '').substring(5, 10)),
      sales: byOwner[firstOwner].slice(0, 7).reverse().map(r => num(r['日销售额'])),
      profit: byOwner[firstOwner].slice(0, 7).reverse().map(r => num(r['日毛利额']))
    } : { days: [], sales: [], profit: [] }
  };
}

async function main() {
  const userToken = process.env.FEISHU_USER_TOKEN;
  if (!userToken) {
    console.error('ERROR: FEISHU_USER_TOKEN not set');
    process.exit(1);
  }

  console.log('=== 开始同步飞书数据 ===\n');

  // Fetch all tables
  const fetchData = {};
  for (const [key, table] of Object.entries(TABLES)) {
    console.log(`正在获取: ${table.name}`);
    try {
      fetchData[key] = await fetchTableRecords(userToken, table.id, table.name);
    } catch (e) {
      if (e.message.startsWith('TOKEN_EXPIRED')) {
        console.error('\n❌ Token 已过期，请重新授权飞书');
        process.exit(2);
      }
      console.error(`  获取失败: ${e.message}`);
      fetchData[key] = [];
    }
  }

  // Process data
  console.log('\n=== 处理数据 ===');
  const processed = {};
  processed['sync_time'] = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  Object.assign(processed, processDashboard(fetchData.daily_sales));

  // Target summary
  processed['target_summary_all'] = fetchData.target_summary.map(r => ({
    owner: r['负责人'], month_target: num(r['月目标销售额']),
    month_actual: num(r['月已完成销售额']), daily_target: num(r['日目标销售额']),
  }));

  // Core links by person
  const linksByPerson = {};
  for (const r of fetchData.core_links) {
    const owner = r['负责人'];
    if (!owner) continue;
    if (!linksByPerson[owner]) linksByPerson[owner] = [];
    linksByPerson[owner].push({ name: r['商品名称'], sales: num(r['日销量']), amount: num(r['日销售额']) });
  }
  processed['core_links_by_person'] = linksByPerson;

  // Inventory risks
  const riskItems = [];
  for (const r of fetchData.inventory) {
    const stockDays = num(r['30天可售天数']);
    const onWay = num(r['在途']); const airport = num(r['空港']);
    const purchase = num(r['采购预定']); const goodStock = num(r['良品库存']);
    const maruyaSales = num(r['丸屋30天销量']);
    if (goodStock === 0 && onWay === 0 && airport === 0 && purchase === 0) continue;
    const reminders = [];
    if (stockDays > 0 && stockDays < 20 && onWay === 0 && airport > 0) reminders.push('需要调拨');
    if (stockDays > 0 && stockDays < 25 && onWay === 0 && airport === 0) {
      reminders.push(purchase === 0 ? '采购预定' : '可能缺货');
    }
    if (goodStock > 0 && airport > 0 && maruyaSales === 0) reminders.push('新品/上架检查');
    
    const otherStoreReminder = r['提醒列'] || '';
    if (otherStoreReminder && (
      otherStoreReminder.indexOf('西选') >= 0 ||
      otherStoreReminder.indexOf('寰瑞') >= 0 ||
      otherStoreReminder.indexOf('二马路') >= 0 ||
      otherStoreReminder.indexOf('阿里健康') >= 0
    )) {
      if (!reminders.includes('其他店铺销售不错')) reminders.push('其他店铺销售不错');
    }
    
    if (reminders.length > 0) riskItems.push({
      product_name: r['商品名称'] || '', barcode: r['货品条码'] || '', brand: r['品牌'] || '',
      good_stock: String(r['良品库存'] || ''), stock_days: String(r['30天可售天数'] || ''),
      airport: String(r['空港'] || ''), on_the_way: String(r['在途'] || ''),
      reminders: reminders.join('；'), types: reminders, owner: r['丸屋负责人'] || '',
      maruya_30d_sales: String(r['丸屋30天销量'] || ''),
      other_store_reminder: otherStoreReminder
    });
  }
  processed['inventory_risks'] = riskItems;
  console.log(`  库存风险项: ${riskItems.length} 条`);

  // Inventory TOP10
  processed['inventory_top10'] = fetchData.inventory
    .filter(r => r['丸屋负责人'] === '符美玲' && num(r['丸屋30天销量']) > 0)
    .map(r => ({
      name: r['商品名称'] || '', barcode: r['货品条码'] || '',
      sales_30d: num(r['丸屋30天销量']), good_stock: String(r['良品库存'] || ''),
      stock_days: String(r['30天可售天数'] || ''), airport: String(r['空港'] || ''),
      status: String(r['货品状态'] || '')
    }))
    .sort((a, b) => b.sales_30d - a.sales_30d).slice(0, 10);
  console.log(`  在途爆款TOP10: ${processed['inventory_top10'].length} 条`);

  // Other store sales comparison
  processed['other_store_sales'] = riskItems
    .filter(r => r.types && r.types.includes('其他店铺销售不错'))
    .map(r => ({
      product_name: r.product_name, brand: r.brand, barcode: r.barcode,
      sales_7d: 0, sales_30d: num(r.maruya_30d_sales),
      good_stock: r.good_stock, reminder: r.other_store_reminder,
      maruya_30d: num(r.maruya_30d_sales)
    }));
  console.log(`  其他店铺销售不错: ${processed['other_store_sales'].length} 条`);

  // Scheduled tasks
  processed['scheduled_tasks'] = {
    tasks: [
      { id: "--ZG6359VH3UL7", name: "飞书数据自动同步", cron: "45 14 * * MON-FRI", cron_desc: "工作日 14:45", status: "active", executions: 15, category: "数据同步" },
      { id: "1ELJQZIX3WCJ7G", name: "库存提醒自动更新", cron: "0 16 * * MON", cron_desc: "每周一 16:00", status: "active", executions: 3, category: "库存预警" },
      { id: "RLA4PV-UCKN4HW", name: "烘焙选题库自动刷新", cron: "30 9 * * MON,WED,FRI", cron_desc: "周一三五 09:30", status: "active", executions: 6, category: "内容运营" }
    ],
    updated_at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-').substring(0, 16)
  };

  // Write output
  const jsContent = `window.FEISHU_DATA = ${JSON.stringify(processed)};`;
  fs.writeFileSync('./feishu-data-live.js', jsContent, 'utf-8');
  
  console.log(`\n=== 同步完成 ===`);
  console.log(`  数据日期: ${processed.dashboard.data_date}`);
  console.log(`  负责人: ${Object.keys(processed.dashboard_by_owner).join(', ')}`);
  console.log(`  文件大小: ${(jsContent.length / 1024).toFixed(1)} KB`);
}

main().catch(e => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
