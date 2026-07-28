const path = require('node:path');
const { assertProductionDependencyTopology } = require('./dependency-topology');

const repositoryRoot = path.resolve(__dirname, '..');
const evidence = assertProductionDependencyTopology({ repositoryRoot });
console.log(`Production dependency topology verified: ${evidence.checkedRuntimes} runtimes checked; ${evidence.excludedPackages.length} excluded package names absent.`);
