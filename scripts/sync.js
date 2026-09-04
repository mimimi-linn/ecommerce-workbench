// Sync script for GitHub Actions
// Uses App credentials (tenant_access_token) - no token refresh needed!
// No external dependencies - uses only Node.js built-in modules

const https = require('https');
const fs = require('fs');

const APP_ID = "cli_aac130aabb799bb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "6uYLfShxUfygGRxpBUGZhbIxJX4yHOSa";
const BASE_TOKEN = "Yc1vbUbGAaayxdspPnQc3pmjn5d";
const TABLES = {
  target_summary: { id: "tbl438GW0vARpaQI", name: "目标与达成汇总表" },
  daily_sales: { id: "tblHDDLJUm52B9rr", name: "观星台日销售数据" },
  inventory: { id: "tbl1HnZaiTgPJG1C", name: "商品库存在途数据表" }
};

function num(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/,/g, '').replace(/¥/g, '').replace(/%/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function tsToDate(ts) {
  if (!ts) return '';
  let ms = typeof ts === 'number' ? ts : parseInt(ts);
  if (ms < 1e12) ms *= 1000;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

async function getTenantAccessToken() {
  console.log('获取 tenant_access_token...');
  const data = await fetchJSON('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });
  if (data.code !== 0) {
    throw new Error(`获取 token 失败: ${data.msg} (code: ${data.code})`);
  }
  console.log(`  ✅ Token 获取成功，有效期 ${data.expire} 秒`);
  return data.tenant_access_token;
}

async function fetchTableRecords(token, tableId, tableName) {
  const allRecords = [];
  let pageToken = '';

  while (true) {
    const params = new URLSearchParams({ page_size: '200' });
    if (pageToken) params.set('page_token', pageToken);

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${tableId}/records?${params}`;
    const data = await fetchJSON(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (data.code !== 0) {
      console.error(`  获取 ${tableName} 失败: ${data.msg} (code: ${data.code})`);
      break;
    }

    const items = data.data.items || [];
    for (const item of items) {
      const record = {};
      for (const [key, val] of Object.entries(item.fields)) {
        record[key] = normalizeValue(val);
      }
      if (item.fields['数据日期'] && typeof item.fields['数据日期'] === 'number') {
        record['数据日期'] = tsToDate(item.fields['数据日期']);
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

function processDashboard(dailyRecords, targetRecords) {
  const targetMap = {};
  for (const r of targetRecords) {
    const owner = r['监控维度 (人员 )'] || r['负责人'] || '';
    if (!owner) continue;
    targetMap[owner] = {
      target_sales: num(r['目标销售']),
      target_profit: num(r['目标毛利']),
      actual_sales: num(r['实际销售']),
      actual_profit: num(r['实际毛利']),
      ad_cost: num(r['推广费用']),
      sales_rate: num(r['销售达成率']),
      profit_rate: num(r['毛利达成率（%）'])
    };
  }

  const owners = Object.keys(targetMap);
  const byOwner = {};
  
  for (const r of dailyRecords) {
    const owner = r['负责人'];
    if (!owner) continue;
    if (!byOwner[owner]) byOwner[owner] = [];
    byOwner[owner].push(r);
  }

  const dashboardByOwner = {};
  for (const owner of owners) {
    const records = (byOwner[owner] || []).sort((a, b) => {
      return String(b['数据日期'] || '').localeCompare(String(a['数据日期'] || ''));
    });
    if (records.length === 0) continue;

    const latest = records[0];
    const dataDate = String(latest['数据日期'] || '').substring(0, 10);

    const dailySales = records.reduce((s, r) => s + num(r['支付金额']), 0);
    const dailyProfit = records.reduce((s, r) => s + num(r['商品毛利_预估']), 0);
    const dailyAdCost = records.reduce((s, r) => s + num(r['推广费小计(未计算补贴)']), 0);
    const dailySalesCount = records.reduce((s, r) => s + num(r['销量']), 0);
    const dailyRefund = records.reduce((s, r) => s + num(r['退款金额']), 0);
    
    const target = targetMap[owner] || {};
    const targetSales = target.target_sales || 0;
    const targetProfit = target.target_profit || 0;
    
    const achievementRate = targetSales > 0 ? (dailySales / targetSales * 100) : 0;
    const profitRate = targetProfit > 0 ? (dailyProfit / targetProfit * 100) : 0;
    const feeRatio = dailySales > 0 ? (dailyAdCost / dailySales * 100) : 0;
    const margin = dailySales > 0 ? (dailyProfit / dailySales * 100) : 0;

    const productMap = {};
    for (const r of records.slice(0, 50)) {
      const pname = r['商品标题'] || r['商品名称'];
      if (!pname) continue;
      if (!productMap[pname]) productMap[pname] = { name: pname, sales: 0, amount: 0, barcode: r['条形码'] || r['货品条码'] || '' };
      productMap[pname].sales += num(r['销量']);
      productMap[pname].amount += num(r['支付金额']);
    }
    const top5 = Object.values(productMap).sort((a, b) => b.sales - a.sales).slice(0, 5);

    const dailyAgg = {};
    for (const r of (byOwner[owner] || [])) {
      const dt = String(r['数据日期'] || '').substring(0, 10);
      if (!dt || dt === 'None') continue;
      if (!dailyAgg[dt]) dailyAgg[dt] = { sales: 0, profit: 0 };
      dailyAgg[dt].sales += num(r['支付金额']);
      dailyAgg[dt].profit += num(r['商品毛利_预估']);
    }
    const sortedDates = Object.keys(dailyAgg).sort();
    const recent7d = sortedDates.slice(-7);
    const trend7d = recent7d.map(dt => ({
      date: dt.substring(5),
      sales: Math.round(dailyAgg[dt].sales),
      profit: Math.round(dailyAgg[dt].profit)
    }));

    dashboardByOwner[owner] = {
      data_date: dataDate,
      actual_sales: Math.round(dailySales),
      actual_profit: Math.round(dailyProfit),
      target_sales: Math.round(targetSales),
      target_profit: Math.round(targetProfit),
      achievement_rate: Math.round(achievementRate * 10) / 10,
      profit_rate: Math.round(profitRate * 10) / 10,
      fee_ratio: Math.round(feeRatio * 10) / 10,
      margin: Math.round(margin * 10) / 10,
      ad_cost: Math.round(dailyAdCost),
      refund: Math.round(dailyRefund),
      sales_count: Math.round(dailySalesCount),
      top5_products: top5,
      trend_7d: trend7d
    };
  }

  const firstOwner = owners.find(o => dashboardByOwner[o]) || owners[0];
  return {
    dashboard: dashboardByOwner[firstOwner] || { data_date: '--', actual_sales: 0, actual_profit: 0, target_sales: 0, achievement_rate: 0, fee_ratio: 0, top5_products: [], trend_7d: [] },
    dashboard_by_owner: dashboardByOwner,
    target_summary_all: owners.map(o => ({
      owner: o,
      target_sales: targetMap[o].target_sales,
      target_profit: targetMap[o].target_profit,
      actual_sales: targetMap[o].actual_sales,
      actual_profit: targetMap[o].actual_profit,
      ad_cost: targetMap[o].ad_cost,
      sales_rate: targetMap[o].sales_rate,
      profit_rate: targetMap[o].profit_rate
    }))
  };
}

async function main() {
  console.log('=== 开始同步飞书数据（App 凭证模式）===\n');

  // Step 1: Get tenant_access_token (永不过期方案)
  const token = await getTenantAccessToken();

  // Step 2: Fetch all tables
  const fetchData = {};
  for (const [key, table] of Object.entries(TABLES)) {
    console.log(`\n正在获取: ${table.name}`);
    try {
      fetchData[key] = await fetchTableRecords(token, table.id, table.name);
    } catch (e) {
      console.error(`  获取失败: ${e.message}`);
      fetchData[key] = [];
    }
  }

  // Step 3: Process data
  console.log('\n=== 处理数据 ===');
  const processed = {};
  processed['sync_time'] = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  
  const dashboardData = processDashboard(fetchData.daily_sales, fetchData.target_summary);
  Object.assign(processed, dashboardData);

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
    
    const reminderText = r['提醒'] || r['提醒列'] || '';
    if (reminderText && (
      reminderText.indexOf('西选') >= 0 ||
      reminderText.indexOf('寰瑞') >= 0 ||
      reminderText.indexOf('二马路') >= 0 ||
      reminderText.indexOf('阿里健康') >= 0
    )) {
      if (!reminders.includes('其他店铺销售不错')) reminders.push('其他店铺销售不错');
    }
    
    if (reminders.length > 0) riskItems.push({
      product_name: r['货品名称'] || r['商品名称'] || '', 
      barcode: r['条形码'] || r['货品条码'] || '', 
      brand: r['品牌'] || '',
      good_stock: String(r['良品库存'] || ''), 
      stock_days: String(r['30天可售天数'] || ''),
      airport: String(r['空港'] || ''), 
      on_the_way: String(r['在途'] || ''),
      reminders: reminders.join('；'), 
      types: reminders, 
      owner: r['丸屋负责人'] || '',
      maruya_30d_sales: String(r['丸屋30天销量'] || ''),
      other_store_reminder: reminderText
    });
  }
  processed['inventory_risks'] = riskItems;
  console.log(`  库存风险项: ${riskItems.length} 条`);

  // Inventory TOP10
  processed['inventory_top10'] = fetchData.inventory
    .filter(r => r['丸屋负责人'] === '符美玲' && num(r['丸屋30天销量']) > 0)
    .map(r => ({
      name: r['货品名称'] || r['商品名称'] || '', 
      barcode: r['条形码'] || r['货品条码'] || '',
      sales_30d: num(r['丸屋30天销量']), 
      good_stock: String(r['良品库存'] || ''),
      stock_days: String(r['30天可售天数'] || ''), 
      airport: String(r['空港'] || ''),
      status: String(r['货品状态'] || '')
    }))
    .sort((a, b) => b.sales_30d - a.sales_30d).slice(0, 10);
  console.log(`  在途爆款TOP10: ${processed['inventory_top10'].length} 条`);

  // Other store sales
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
