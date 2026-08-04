'use strict';

require('dotenv').config();

const { getTokenHmacMigrationProgress } = require('../src/db');

const progress = getTokenHmacMigrationProgress();
console.log(JSON.stringify(progress, null, 2));
