const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('./package.json'));

const version = manifest.version.split('.')

console.log(`Program version: ${manifest.version}`);

const patchNumber = parseInt(process.argv[2])

if (patchNumber === NaN) {
    throw new Error('Invalid argument');
}

version[version.length - 1] = patchNumber;
manifest.version = version.join('.');
fs.writeFileSync('./package.json', JSON.stringify(manifest));

console.log(`Program version after modification: ${manifest.version}`);
