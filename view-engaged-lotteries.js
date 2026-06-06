#!/usr/bin/env node

const path = require('node:path');
const dotenv = require('dotenv');
const {
  countEngagements,
  openEngagedStore,
  renderEngagementHtml,
} = require('./engaged-store');

const ROOT_DIR = __dirname;
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT_DIR, '.env'), quiet: true });

const ENGAGED_DB = process.env.ZF_ENGAGED_DB || path.join(ROOT_DIR, 'engaged-lotteries.sqlite');
const ENGAGED_HTML = process.env.ZF_ENGAGED_HTML || path.join(ROOT_DIR, 'engaged-lotteries.html');

const store = openEngagedStore(ENGAGED_DB, ENGAGED_HTML);
renderEngagementHtml(store);
console.log(`Generated ${ENGAGED_HTML} with ${countEngagements(store)} records.`);
store.db.close();
