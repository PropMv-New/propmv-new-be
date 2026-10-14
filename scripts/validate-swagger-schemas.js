/**
 * ------------------------------------------------------------------
 * File: validate-swagger-schemas.js
 * Module: Admin Scripts
 *
 * Purpose:
 * Administrative script for database sync, testing, or system maintenance tasks.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// Import the complete API schemas
const completeApiSchemas = require('../src/docs/api-schemas/complete-api-schemas');

// Function to scan route files and extract API endpoints
function scanRouteFiles() {
    const modulesPath = path.join(__dirname, '../src/portals/landlord/modules');
    const endpoints = [];

    const scanDirectory = (dir) => {
        const items = fs.readdirSync(dir);

        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                scanDirectory(fullPath);
            } else if (item.endsWith('.routes.js') || item.endsWith('.js')) {
                const content = fs.readFileSync(fullPath, 'utf8');

                // Extract module name from path
                const pathParts = fullPath.split(path.sep);
                const moduleIndex = pathParts.findIndex(part => part === 'modules');
                const moduleName = moduleIndex !== -1 ? pathParts[moduleIndex + 1] : 'unknown';

                // Extract router method calls
                const routerMethods = content.match(/router\.(post|put|patch|delete|get)\s*\(\s*['"`]([^'"`]+)['"`]/g);

                if (routerMethods) {
                    routerMethods.forEach(match => {
                        const methodMatch = match.match(/router\.(\w+)\s*\(\s*['"`]([^'"`]+)['"`]/);
                        if (methodMatch) {
                            const method = methodMatch[1].toUpperCase();
                            const route = methodMatch[2];

                            // Convert route to full API path
                            let fullRoute = `/api/v1/${moduleName}${route}`;
                            if (route.startsWith('/')) {
                                fullRoute = `/api/v1/${moduleName}${route}`;
                            } else {
                                fullRoute = `/api/v1/${moduleName}/${route}`;
                            }

                            // Normalize the route
                            fullRoute = fullRoute.replace(/\/+/g, '/');

                            // Convert express params to OpenAPI format
                            const openApiRoute = fullRoute.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

                            endpoints.push({
                                method,
                                route: openApiRoute,
                                file: fullPath,
                                module: moduleName,
                                originalRoute: route,
                                needsRequestBody: ['POST', 'PUT', 'PATCH'].includes(method)
                            });
                        }
                    });
                }
            }
        }
    };

    scanDirectory(modulesPath);
    return endpoints;
}

// Function to check schema coverage
function checkSchemaCoverage() {
    console.log('🔍 Scanning API endpoints and checking Swagger schema coverage...\n');

    const endpoints = scanRouteFiles();
    const schemaKeys = Object.keys(completeApiSchemas);

    console.log(`📊 Found ${endpoints.length} total endpoints`);
    console.log(`📋 Available schemas: ${schemaKeys.length}\n`);

    const endpointsNeedingSchemas = endpoints.filter(ep => ep.needsRequestBody);
    console.log(`🎯 Endpoints needing request body schemas: ${endpointsNeedingSchemas.length}\n`);

    let coveredCount = 0;
    let missingSchemas = [];

    console.log('📝 Schema Coverage Report:\n');

    endpointsNeedingSchemas.forEach(endpoint => {
        const schemaKey = `${endpoint.method} ${endpoint.route}`;
        const hasSchema = completeApiSchemas[schemaKey];

        if (hasSchema) {
            console.log(`${schemaKey}`);
            coveredCount++;
        } else {
            console.log(` ${schemaKey} - MISSING SCHEMA`);
            missingSchemas.push({
                key: schemaKey,
                endpoint: endpoint
            });
        }
    });

    console.log(`\n📈 Coverage Summary:`);
    console.log(`Covered: ${coveredCount}/${endpointsNeedingSchemas.length} (${Math.round(coveredCount / endpointsNeedingSchemas.length * 100)}%)`);
    console.log(` Missing: ${missingSchemas.length}`);

    if (missingSchemas.length > 0) {
        console.log(`\n🚨 Missing Schemas:`);
        missingSchemas.forEach(missing => {
            console.log(`   - ${missing.key}`);
            console.log(`     File: ${missing.endpoint.file}`);
            console.log(`     Module: ${missing.endpoint.module}`);
            console.log('');
        });
    }

    // Check for unused schemas
    console.log(`\n🔍 Checking for unused schemas...`);
    const usedSchemas = new Set();
    endpointsNeedingSchemas.forEach(endpoint => {
        const schemaKey = `${endpoint.method} ${endpoint.route}`;
        if (completeApiSchemas[schemaKey]) {
            usedSchemas.add(schemaKey);
        }
    });

    const unusedSchemas = schemaKeys.filter(key => !usedSchemas.has(key));
    if (unusedSchemas.length > 0) {
        console.log(`⚠️  Unused schemas found: ${unusedSchemas.length}`);
        unusedSchemas.forEach(schema => {
            console.log(`   - ${schema}`);
        });
    } else {
        console.log(`All schemas are being used`);
    }

    console.log(`\n🎉 Schema validation complete!`);

    return {
        total: endpointsNeedingSchemas.length,
        covered: coveredCount,
        missing: missingSchemas,
        unused: unusedSchemas,
        coveragePercent: Math.round(coveredCount / endpointsNeedingSchemas.length * 100)
    };
}

// Function to generate missing schema templates
function generateMissingSchemaTemplates(missingSchemas) {
    if (missingSchemas.length === 0) {
        console.log('No missing schemas to generate templates for.');
        return;
    }

    console.log('\n📝 Generating schema templates for missing endpoints...\n');

    const templates = {};

    missingSchemas.forEach(missing => {
        const { key, endpoint } = missing;

        // Generate basic template based on method and route
        const template = {
            schema: {
                type: 'object',
                properties: {
                    // Add common properties based on route patterns
                },
                additionalProperties: false
            },
            example: {}
        };

        // Add common patterns based on route
        if (endpoint.route.includes('/{id}')) {
            // This is likely an update endpoint
            template.schema.properties.id = { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
        }

        if (endpoint.module === 'property') {
            template.schema.properties.name = { type: 'string' };
            template.schema.properties.description = { type: 'string' };
        } else if (endpoint.module === 'tenants') {
            template.schema.properties.firstName = { type: 'string' };
            template.schema.properties.lastName = { type: 'string' };
            template.schema.properties.email = { type: 'string', format: 'email' };
        }

        templates[key] = template;
    });

    // Output the templates
    console.log('// Add these schema templates to complete-api-schemas.js:\n');
    Object.entries(templates).forEach(([key, template]) => {
        console.log(`    '${key}': ${JSON.stringify(template, null, 8).replace(/^/gm, '    ')},\n`);
    });
}

// Main execution
if (require.main === module) {
    const results = checkSchemaCoverage();

    if (results.missing.length > 0) {
        generateMissingSchemaTemplates(results.missing);
    }

    console.log(`\n🏁 Final Results:`);
    console.log(`   Coverage: ${results.coveragePercent}%`);
    console.log(`   Status: ${results.coveragePercent === 100 ? 'COMPLETE' : '⚠️  NEEDS WORK'}`);
}

module.exports = {
    scanRouteFiles,
    checkSchemaCoverage,
    generateMissingSchemaTemplates
};