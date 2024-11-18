require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const yahooFinance = require("yahoo-finance2").default;
const fs = require("fs");

const SYMBOLS = require("./symbols.json");

const DATA_PATH = "./data";

async function getAllSymbols() {
  // remove symbols from DATA_PATH
  const files = fs.readdirSync(DATA_PATH);
  const existingSymbols = files.map((file) => file.replace(".json", ""));
  const symbols = SYMBOLS.filter((symbol) => !existingSymbols.includes(symbol));
  return symbols;
}

// https://fundamentus.com.br/detalhes.php?papel=SAPR4
async function getSymbolDetails(symbol) {
  const response = await axios.get(`https://fundamentus.com.br/detalhes.php?papel=${symbol}`);

  const $ = cheerio.load(response.data);

  const details = {};

  details.price = parseFloat(
    $(
      "body > div.center > div.conteudo.clearfix > table:nth-child(2) > tbody > tr:nth-child(1) > td.data.destaque.w3 > span"
    )
      .text()
      .replace(",", ".")
  );
  details.business = $(
    "body > div.center > div.conteudo.clearfix > table:nth-child(2) > tbody > tr:nth-child(5) > td:nth-child(2)"
  ).text();
  details.priceToEarnings = parseFloat(
    $(
      "body > div.center > div.conteudo.clearfix > table:nth-child(4) > tbody > tr:nth-child(2) > td:nth-child(4) > span"
    )
      .text()
      .replace(",", ".")
  );

  return details;
}

async function getHolders(symbol) {
  const response = await axios.get(`https://fundamentus.com.br/acionistas.php?papel=${symbol}`);

  const $ = cheerio.load(response.data);

  const holders = [];
  $(".my-menu li ul li a").each((i, el) => {
    const holder = {};

    holder.name = $(el)
      .clone() //clone the element
      .children() //select all the children
      .remove() //remove all the children
      .end() //again go back to selected element
      .text();
    holder.ordinaryShares = parseFloat(
      $(el).find("table td:nth-child(1)").text().replace(",", ".").replace("%", "")
    );
    holder.preferredShares = parseFloat(
      $(el).find("table td:nth-child(2)").text().replace(",", ".").replace("%", "")
    );
    holder.totalShares = parseFloat(
      $(el).find("table td:nth-child(3)").text().replace(",", ".").replace("%", "")
    );

    holders.push(holder);
  });
  return holders;
}

async function getEvents(symbol) {
  const response = await axios.get(
    `https://fundamentus.com.br/proventos.php?papel=${symbol}&tipo=2`
  );

  const $ = cheerio.load(response.data);

  const events = [];

  $("#resultado tbody tr").each((i, el) => {
    const event = {};

    const date = $(el).find("td:nth-child(1)").text();
    const [dd, mm, yyyy] = date.split("/");
    event.date = new Date(yyyy, mm - 1, dd).getTime();
    event.amount = parseFloat($(el).find("td:nth-child(2)").text().replace(",", "."));
    event.type = $(el).find("td:nth-child(3)").text();

    events.push(event);
  });

  return events;
}

async function getHistory(symbol) {
  const result = await yahooFinance.quoteSummary(`${symbol}.SA`, {
    modules: ["earnings", "incomeStatementHistory", "financialData"],
  });

  const earningsPerShare =
    result.earnings?.financialsChart?.yearly.map((item) => ({
      period: new Date(`${item.date}-01-31`).getTime(),
      value: item.earnings,
    })) ?? [];

  const netMargin = result.incomeStatementHistory.incomeStatementHistory.map((incomeStatement) => ({
    period: new Date(incomeStatement.endDate).getTime(),
    value: incomeStatement.netIncome / incomeStatement.totalRevenue,
  }));

  const debtByAnnualEquity = result.financialData.debtToEquity;

  return {
    debtByAnnualEquity,
    earningsPerShare,
    netMargin,
  };
}

async function scrapper() {
  const symbols = await getAllSymbols();

  console.log(`[info] ${symbols.length} symbols fetched`);

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    try {
      const details = await getSymbolDetails(symbol);
      if (!details.price) throw new Error(`Unable to find stock details for ${symbol}...`);
      const holders = await getHolders(symbol);
      const events = await getEvents(symbol);
      const { debtByAnnualEquity, earningsPerShare, netMargin } = await getHistory(symbol);

      const data = {
        name: symbol,
        business: details.business,
        currentState: {
          price: details.price,
          priceToEarnings: details.priceToEarnings,
          debtByAnnualEquity,
          holders: holders.filter(
            (holder) =>
              holder.name.toUpperCase() !== "OUTROS" &&
              holder.name.toUpperCase() !== "ACOESTESOURARIA"
          ),
        },
        events,
        history: {
          earningsPerShare,
          netMargin,
        },
      };

      fs.writeFile(`${DATA_PATH}/${symbol}.json`, JSON.stringify(data, null, 2), (err) => {
        if (err) throw err;
      });

      console.log(`[info] success processing ${symbol}...`);
    } catch (error) {
      console.log(`[error] failed to process ${symbol}:`, error);
    }
  }
}

scrapper();
