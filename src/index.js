require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const { MongoClient } = require("mongodb");
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

const finnhubToken = process.env.FINNHUB_TOKEN;

async function getAllSymbols() {
  const response = await axios.get(`https://finnhub.io/api/v1/stock/symbol?exchange=SA&token=${finnhubToken}`);

  const symbols = response.data.map((stock) => ({
    name: stock.symbol.split(".")[0],
    description: stock.description,
  }));

  return symbols;
}

// https://fundamentus.com.br/detalhes.php?papel=SAPR4
async function getSymbolDetails(symbol) {
  const response = await axios.get(`https://fundamentus.com.br/detalhes.php?papel=${symbol}`);

  const $ = cheerio.load(response.data);

  const details = {};

  details.price = parseFloat(
    $("body > div.center > div.conteudo.clearfix > table:nth-child(2) > tbody > tr:nth-child(1) > td.data.destaque.w3 > span")
      .text()
      .replace(",", ".")
  );
  details.business = $("body > div.center > div.conteudo.clearfix > table:nth-child(2) > tbody > tr:nth-child(5) > td:nth-child(2)").text();
  details.priceToEarnings = parseFloat(
    $("body > div.center > div.conteudo.clearfix > table:nth-child(4) > tbody > tr:nth-child(2) > td:nth-child(4) > span").text().replace(",", ".")
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
    holder.ordinaryShares = parseFloat($(el).find("table td:nth-child(1)").text().replace(",", ".").replace("%", ""));
    holder.preferredShares = parseFloat($(el).find("table td:nth-child(2)").text().replace(",", ".").replace("%", ""));
    holder.totalShares = parseFloat($(el).find("table td:nth-child(3)").text().replace(",", ".").replace("%", ""));

    holders.push(holder);
  });
  return holders;
}

async function getEvents(symbol) {
  const response = await axios.get(`https://fundamentus.com.br/proventos.php?papel=${symbol}&tipo=2`);

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
  const response = await axios.get(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}.SA&metric=all&token=${finnhubToken}`);

  const earningsPerShare = response.data.series?.annual?.eps.map(({ period, v }) => ({
    period: new Date(period).getTime(),
    value: v,
  }));

  const netMargin = response.data.series?.annual?.netMargin.map(({ period, v }) => ({
    period: new Date(period).getTime(),
    value: v,
  }));

  const debtByAnnualEquity = response.data.metric["totalDebt/totalEquityAnnual"];

  return { debtByAnnualEquity, earningsPerShare, netMargin };
}

async function scrapper(collection) {
  const symbols = await getAllSymbols();

  console.log(`[info] ${symbols.length} symbols fetched`);

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];

    try {
      const details = await getSymbolDetails(symbol.name);
      if (!details.price) throw new Error("Unable to find stock details...");
      const holders = await getHolders(symbol.name);
      const events = await getEvents(symbol.name);
      const { debtByAnnualEquity, earningsPerShare, netMargin} = await getHistory(symbol.name);

      const data = {
        name: symbol.name,
        business: details.business,
        currentState: {
          price: details.price,
          priceToEarnings: details.priceToEarnings,
          debtByAnnualEquity,
          holders: holders.filter((holder) => holder.name.toUpperCase() !== "OUTROS" && holder.name.toUpperCase() !== "ACOESTESOURARIA"),
        },
        events,
        history:{
            earningsPerShare,
            netMargin,
        }
      };

      await collection.updateOne({ name: symbol.name }, { $set: data }, { upsert: true });

      console.log(`[info] success processing ${symbol.name}...`);
    } catch (error) {
      console.log(`[error] failed to process ${symbol.name}:`, error);
    }
  }
}

client.connect(async (err) => {
  const collection = client.db("database").collection("stocks");
  await scrapper(collection);
  client.close();
});
