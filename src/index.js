import eBayApi from 'ebay-api';

// ─── Configuration ──────────────────────────────────────────────
const SEARCH_QUERY = 'TI-84 Plus calculator';
const CONDITION = 'Used';
const DEAL_THRESHOLD = 0.65; // Flag items at 65% or less of median price
const EBAY_FEE_RATE = 0.13; // ~13% eBay seller fees
const RESULTS_PER_PAGE = 100;

// ─── Initialize eBay client from .env ───────────────────────────
const eBay = eBayApi.fromEnv();

// ─── Helpers ────────────────────────────────────────────────────
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function average(numbers) {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function formatCurrency(n) {
  return `$${n.toFixed(2)}`;
}

function filterOutliers(prices) {
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered = sorted.filter((p) => p >= lower && p <= upper);

  return {
    filtered,
    lower: Math.max(lower, 0),
    upper,
    removedCount: prices.length - filtered.length,
  };
}

// ─── Step 1: Get sold prices (market value) ─────────────────────
async function getSoldPrices(query, condition) {
  console.log(`\n📊 Fetching sold listings for "${query}" (${condition})...\n`);

  const allItems = [];
  let page = 1;
  const maxPages = 3; // up to 300 results

  while (page <= maxPages) {
    try {
      const result = await eBay.finding.findItemsAdvanced({
        keywords: query,
        itemFilter: [
          { name: 'SoldItemsOnly', value: 'true' },
          { name: 'Condition', value: condition },
        ],
        sortOrder: 'EndTimeSoonest',
        paginationInput: {
          entriesPerPage: RESULTS_PER_PAGE,
          pageNumber: page,
        },
      });

      const items = result?.searchResult?.item;
      if (!items || items.length === 0) break;

      allItems.push(...items);

      const totalPages = parseInt(
        result?.paginationOutput?.totalPages || '1',
        10
      );
      if (page >= totalPages) break;
      page++;
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err.message);
      break;
    }
  }

  return allItems;
}

// ─── Step 2: Analyze sold prices ────────────────────────────────
function analyzePrices(soldItems) {
  const prices = soldItems
    .map((item) => {
      const priceVal =
        item?.sellingStatus?.currentPrice?.value ??
        item?.sellingStatus?.currentPrice;
      return parseFloat(typeof priceVal === 'object' ? priceVal.value : priceVal);
    })
    .filter((p) => !isNaN(p) && p > 0);

  if (prices.length === 0) {
    console.log('❌ No sold price data found.');
    return null;
  }

  const sorted = [...prices].sort((a, b) => a - b);

  // Raw stats (before outlier removal)
  console.log('─'.repeat(50));
  console.log('  RAW SOLD PRICES (last ~90 days)');
  console.log('─'.repeat(50));
  console.log(`  Items analyzed:  ${prices.length}`);
  console.log(`  Average price:   ${formatCurrency(average(prices))}`);
  console.log(`  Median price:    ${formatCurrency(median(prices))}`);
  console.log(`  Low / High:      ${formatCurrency(sorted[0])} — ${formatCurrency(sorted[sorted.length - 1])}`);
  console.log('─'.repeat(50));

  // IQR outlier removal
  const { filtered, lower, upper, removedCount } = filterOutliers(prices);

  if (filtered.length === 0) {
    console.log('❌ All prices were filtered as outliers. Check your data.');
    return null;
  }

  const filteredSorted = [...filtered].sort((a, b) => a - b);
  const stats = {
    count: filtered.length,
    average: average(filtered),
    median: median(filtered),
    low: filteredSorted[0],
    high: filteredSorted[filteredSorted.length - 1],
    p25: filteredSorted[Math.floor(filteredSorted.length * 0.25)],
    p75: filteredSorted[Math.floor(filteredSorted.length * 0.75)],
  };

  console.log(`\n  🧹 IQR FILTER: keeping ${formatCurrency(lower)} — ${formatCurrency(upper)}`);
  console.log(`     Removed ${removedCount} outlier(s)\n`);
  console.log('─'.repeat(50));
  console.log('  FILTERED MARKET VALUE');
  console.log('─'.repeat(50));
  console.log(`  Items kept:      ${stats.count} of ${prices.length}`);
  console.log(`  Average price:   ${formatCurrency(stats.average)}`);
  console.log(`  Median price:    ${formatCurrency(stats.median)}  ← used for deal finding`);
  console.log(`  Low / High:      ${formatCurrency(stats.low)} — ${formatCurrency(stats.high)}`);
  console.log(`  25th / 75th pct: ${formatCurrency(stats.p25)} — ${formatCurrency(stats.p75)}`);
  console.log('─'.repeat(50));

  return stats;
}

// ─── Step 3: Find underpriced active listings ───────────────────
async function findDeals(query, condition, marketStats) {
  const maxPrice = Math.floor(marketStats.median * DEAL_THRESHOLD);

  console.log(
    `\n🔎 Searching active listings under ${formatCurrency(maxPrice)} ` +
      `(${DEAL_THRESHOLD * 100}% of ${formatCurrency(marketStats.median)} median)...\n`
  );

  try {
    const results = await eBay.buy.browse.search({
      q: query,
      filter: `conditions:{${condition.toUpperCase()}},price:[..${maxPrice}],priceCurrency:USD`,
      sort: 'price',
      limit: '50',
    });

    const items = results?.itemSummaries;
    if (!items || items.length === 0) {
      console.log('😕 No deals found right now. Try again later!\n');
      return [];
    }

    console.log(`🔥 Found ${items.length} potential deals:\n`);
    console.log(
      'PRICE'.padEnd(10) +
        'PROFIT'.padEnd(12) +
        'AFTER FEES'.padEnd(12) +
        'TITLE'.padEnd(55) +
        'LINK'
    );
    console.log('─'.repeat(120));

    const deals = items.map((item) => {
      const price = parseFloat(item.price.value);
      const grossProfit = marketStats.median - price;
      const fees = marketStats.median * EBAY_FEE_RATE;
      const netProfit = grossProfit - fees;

      return {
        title: item.title,
        price,
        grossProfit,
        netProfit,
        condition: item.condition,
        link: item.itemWebUrl,
        seller: item.seller?.username || 'N/A',
      };
    });

    // Sort by net profit descending
    deals.sort((a, b) => b.netProfit - a.netProfit);

    deals.forEach((deal) => {
      const profitColor = deal.netProfit > 0 ? '✅' : '⚠️';
      console.log(
        formatCurrency(deal.price).padEnd(10) +
          formatCurrency(deal.grossProfit).padEnd(12) +
          `${profitColor} ${formatCurrency(deal.netProfit)}`.padEnd(12) +
          deal.title.substring(0, 52).padEnd(55) +
          deal.link
      );
    });

    console.log('\n─'.repeat(120));
    console.log(
      `\n💡 "PROFIT" = median sold price - listing price`
    );
    console.log(
      `   "AFTER FEES" = profit minus ~${EBAY_FEE_RATE * 100}% eBay fees (shipping costs not included)\n`
    );

    return deals;
  } catch (err) {
    console.error('Error searching active listings:', err.message);
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(50));
  console.log('  eBay Deal Finder — Arbitrage Research Tool');
  console.log('═'.repeat(50));
  console.log(`  Query:     "${SEARCH_QUERY}"`);
  console.log(`  Condition: ${CONDITION}`);
  console.log(`  Threshold: ${DEAL_THRESHOLD * 100}% of median`);
  console.log('═'.repeat(50));

  // Step 1: Get sold data
  const soldItems = await getSoldPrices(SEARCH_QUERY, CONDITION);

  if (soldItems.length === 0) {
    console.log('❌ No sold items found. Check your query or API credentials.');
    process.exit(1);
  }

  // Step 2: Analyze market prices
  const stats = analyzePrices(soldItems);
  if (!stats) process.exit(1);

  // Step 3: Find deals
  await findDeals(SEARCH_QUERY, CONDITION, stats);
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  if (err.message.includes('Invalid access token') || err.message.includes('appId')) {
    console.error(
      '\n💡 Make sure your .env file has valid EBAY_APP_ID and EBAY_CERT_ID values.'
    );
    console.error('   Get them at: https://developer.ebay.com\n');
  }
  process.exit(1);
});
