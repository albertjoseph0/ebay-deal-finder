import eBayApi from 'ebay-api';

// ─── Configuration ──────────────────────────────────────────────
const SEARCH_QUERY = 'TI-84 Plus calculator';
const CONDITION = 'Used';
const MIN_Z_SCORE = -1.0; // Show listings at or below 1 std dev under median
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

function stdDev(numbers, mean) {
  const squaredDiffs = numbers.map((n) => (n - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / numbers.length);
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
  const filteredMean = average(filtered);
  const filteredMedian = median(filtered);
  const filteredStdDev = stdDev(filtered, filteredMean);
  const cv = filteredStdDev / filteredMean;

  const stats = {
    count: filtered.length,
    average: filteredMean,
    median: filteredMedian,
    stdDev: filteredStdDev,
    cv,
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
  console.log(`  Median price:    ${formatCurrency(stats.median)}`);
  console.log(`  Std deviation:   ${formatCurrency(stats.stdDev)}`);
  console.log(`  Low / High:      ${formatCurrency(stats.low)} — ${formatCurrency(stats.high)}`);
  console.log(`  25th / 75th pct: ${formatCurrency(stats.p25)} — ${formatCurrency(stats.p75)}`);
  console.log('─'.repeat(50));

  // σ price bands
  console.log('\n  📐 PRICE BANDS');
  console.log('─'.repeat(50));
  console.log(`  -2σ (strong buy): ${formatCurrency(stats.median - 2 * stats.stdDev)}`);
  console.log(`  -1σ (buy):        ${formatCurrency(stats.median - 1 * stats.stdDev)}`);
  console.log(`   0  (fair value): ${formatCurrency(stats.median)}`);
  console.log(`  +1σ (overpriced): ${formatCurrency(stats.median + 1 * stats.stdDev)}`);
  console.log(`  +2σ (avoid):      ${formatCurrency(stats.median + 2 * stats.stdDev)}`);
  console.log('─'.repeat(50));

  // Market quality verdict
  let marketVerdict;
  if (cv < 0.3) {
    marketVerdict = '✅ Tight market — good for arbitrage';
  } else if (cv < 0.5) {
    marketVerdict = '⚠️  Moderate spread — proceed with caution';
  } else {
    marketVerdict = '❌ High variance — no reliable fair value';
  }
  console.log(`\n  CV: ${cv.toFixed(3)}  →  ${marketVerdict}`);
  console.log('─'.repeat(50));

  return stats;
}

// ─── Step 3: Find underpriced active listings ───────────────────
async function findDeals(query, condition, marketStats) {
  const maxPrice = Math.floor(
    marketStats.median + MIN_Z_SCORE * marketStats.stdDev
  );

  console.log(
    `\n🔎 Searching active listings under ${formatCurrency(maxPrice)} ` +
      `(z ≤ ${MIN_Z_SCORE}, i.e. ${Math.abs(MIN_Z_SCORE)}σ below ${formatCurrency(marketStats.median)} median)...\n`
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
      'Z-SCORE'.padEnd(10) +
        'SIGNAL'.padEnd(16) +
        'PRICE'.padEnd(10) +
        'NET PROFIT'.padEnd(12) +
        'TITLE'.padEnd(50) +
        'LINK'
    );
    console.log('─'.repeat(130));

    const deals = items.map((item) => {
      const price = parseFloat(item.price.value);
      const zScore = (price - marketStats.median) / marketStats.stdDev;
      const grossProfit = marketStats.median - price;
      const fees = marketStats.median * EBAY_FEE_RATE;
      const netProfit = grossProfit - fees;

      let signal;
      if (zScore <= -2) signal = '🔥 Strong buy';
      else if (zScore <= -1) signal = '✅ Buy';
      else signal = '⚠️  Marginal';

      return {
        title: item.title,
        price,
        zScore,
        signal,
        grossProfit,
        netProfit,
        link: item.itemWebUrl,
      };
    });

    // Sort by z-score ascending (most underpriced first)
    deals.sort((a, b) => a.zScore - b.zScore);

    deals.forEach((deal) => {
      console.log(
        deal.zScore.toFixed(2).padEnd(10) +
          deal.signal.padEnd(16) +
          formatCurrency(deal.price).padEnd(10) +
          `${deal.netProfit > 0 ? '+' : ''}${formatCurrency(deal.netProfit)}`.padEnd(12) +
          deal.title.substring(0, 47).padEnd(50) +
          deal.link
      );
    });

    console.log('\n' + '─'.repeat(130));
    console.log(
      `\n💡 Z-SCORE = (listing price - median) / std dev`
    );
    console.log(
      `   NET PROFIT = (median - price) minus ~${EBAY_FEE_RATE * 100}% eBay fees (shipping not included)\n`
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
  console.log(`  Min z:     ${MIN_Z_SCORE} (${Math.abs(MIN_Z_SCORE)}σ below median)`);
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
