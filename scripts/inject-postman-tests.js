const fs = require('fs');
const path = require('path');

const apiSpecPath = path.join(__dirname, '../openapi/kong-local-test-api.json');
const collectionPath = path.join(__dirname, '../openapi/kong-local-test-collection.json');

const apiSpec = JSON.parse(fs.readFileSync(apiSpecPath, 'utf8'));
const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

// Extract x-postman-test-script from openapi spec
const testScripts = {}; // key: "METHOD /path", value: script string

for (const [pathStr, pathObj] of Object.entries(apiSpec.paths)) {
  for (const [method, methodObj] of Object.entries(pathObj)) {
    if (methodObj['x-postman-test-script']) {
      const key = `${method.toUpperCase()} ${pathStr}`;
      testScripts[key] = methodObj['x-postman-test-script'];
    }
  }
}

// Function to recursively traverse collection items and inject tests
function traverseAndInject(items) {
  for (const item of items) {
    if (item.item && Array.isArray(item.item)) {
      traverseAndInject(item.item);
    } else if (item.request) {
      const method = item.request.method;
      // Reconstruct path
      let urlPath = '';
      if (item.request.url && Array.isArray(item.request.url.path)) {
        urlPath = '/' + item.request.url.path.map(p => {
          if (p.startsWith(':')) {
            return `{${p.slice(1)}}`;
          }
          return p;
        }).join('/');
      }
      
      const key = `${method} ${urlPath}`;
      const scriptText = testScripts[key];
      
      if (scriptText) {
        console.log(`Injecting test for: ${key}`);
        // Split scriptText by lines to match Postman exec format
        const lines = scriptText.split('\n');
        item.event = item.event || [];
        
        let testEvent = item.event.find(e => e.listen === 'test');
        if (!testEvent) {
          testEvent = {
            listen: 'test',
            script: {
              exec: lines,
              type: 'text/javascript'
            }
          };
          item.event.push(testEvent);
        } else {
          testEvent.script.exec = lines;
        }
      }
    }
  }
}

traverseAndInject(collection.item);

fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2), 'utf8');
console.log('Collection tests successfully injected and saved!');
