#!/usr/bin/env node

/**
 * Install Scripts Detection Script
 * 
 * Analyzes package-lock.json to identify packages with lifecycle scripts
 * and flags potentially malicious or suspicious patterns.
 * 
 * Lifecycle scripts (preinstall, install, postinstall) execute arbitrary code
 * during `npm install` and are a common supply chain attack vector.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Suspicious patterns with risk levels
const SUSPICIOUS_PATTERNS = [
  {
    name: 'network_access',
    pattern: /curl|wget|fetch|http\.get|https\.get|axios|got|request\(/i,
    description: 'Network access detected',
    risk: 'high'
  },
  {
    name: 'code_evaluation',
    pattern: /eval\(|Function\(|new Function|vm\.runInNewContext|vm\.runInThisContext/i,
    description: 'Dynamic code evaluation',
    risk: 'critical'
  },
  {
    name: 'process_execution',
    pattern: /child_process|exec\(|execSync\(|spawn\(|spawnSync\(|fork\(/i,
    description: 'Process execution',
    risk: 'high'
  },
  {
    name: 'env_access',
    pattern: /process\.env\.|process\.env\[|env\.|ENV\./i,
    description: 'Environment variable access',
    risk: 'medium'
  },
  {
    name: 'encoding_obfuscation',
    pattern: /atob|btoa|base64|Buffer\.from\(.+,\s*['"]base64['"]\)|toString\(['"]base64['"]\)/i,
    description: 'Base64 encoding/obfuscation',
    risk: 'high'
  },
  {
    name: 'hex_obfuscation',
    pattern: /toString\(['"]hex['"]\)|Buffer\.from\(.+,\s*['"]hex['"]\)/i,
    description: 'Hex encoding/obfuscation',
    risk: 'high'
  },
  {
    name: 'destructive_operations',
    pattern: /rm\s+-rf|rmdir|unlink|fs\.rmdirSync|fs\.rmSync|fs\.unlinkSync/i,
    description: 'Destructive file operations',
    risk: 'critical'
  },
  {
    name: 'system_paths',
    pattern: /\/etc\/|\/home\/|\/root\/|\/usr\/|\/var\/|\/tmp\/|C:\\Windows|C:\\Users/i,
    description: 'System path access',
    risk: 'high'
  },
  {
    name: 'shell_execution',
    pattern: /bash|sh\s|zsh|powershell|cmd\.exe|\/bin\//i,
    description: 'Shell execution',
    risk: 'medium'
  },
  {
    name: 'file_write',
    pattern: /fs\.writeFile|fs\.writeFileSync|fs\.appendFile|fs\.appendFileSync|createWriteStream/i,
    description: 'File write operations',
    risk: 'medium'
  },
  {
    name: 'registry_modification',
    pattern: /npm_config|npmrc|\.npmrc|npm set|npm config/i,
    description: 'NPM registry/config modification',
    risk: 'critical'
  },
  {
    name: 'git_operations',
    pattern: /git\s+clone|git\s+pull|\.git\/|github\.com|gitlab\.com|bitbucket\.org/i,
    description: 'Git operations or repository access',
    risk: 'medium'
  },
  {
    name: 'credential_access',
    pattern: /password|token|secret|api_key|apikey|credentials|auth|bearer/i,
    description: 'Potential credential access',
    risk: 'high'
  },
  {
    name: 'outbound_dns',
    pattern: /dns\.lookup|dns\.resolve|getaddrinfo/i,
    description: 'DNS lookups',
    risk: 'medium'
  }
];

// Whitelist for known-safe packages
// These packages are known to use install scripts legitimately
const WHITELIST = [
  'node-gyp',
  'core-js',
  'protobufjs',
  'node-pre-gyp',
  'esbuild',
  'puppeteer',
  'playwright',
  'sharp',
  'sqlite3',
  'better-sqlite3',
  'canvas',
  'node-sass',
  'fsevents',
  'grpc',
  'swc',
  'deasync',
  'koffi',
  'dtrace-provider',
  're2',
  'leveldown',
  'libxmljs',
  'fibers'
];

// Legitimate patterns that might trigger false positives
const LEGITIMATE_PATTERNS = [
  /node-gyp/i,
  /prebuild-install/i,
  /cmake-js/i,
  /npm rebuild/i,
  /tsc|typescript/i,
  /npx|npm run/i
];

class InstallScriptDetector {
  constructor(options = {}) {
    this.lockfilePath = options.lockfilePath || path.join(process.cwd(), 'package-lock.json');
    this.whitelist = new Set([...WHITELIST, ...(options.whitelist || [])]);
    this.report = {
      timestamp: new Date().toISOString(),
      totalPackages: 0,
      packagesWithScripts: 0,
      flaggedPackages: 0,
      packages: []
    };
  }

  /**
   * Main detection function
   */
  async detect() {
    console.error('🔍 Detecting install scripts in package-lock.json...\n');

    try {
      // Parse lockfile
      const lockfile = this.parseLockfile();

      // Find packages with install scripts
      const packagesWithScripts = this.findPackagesWithInstallScripts(lockfile);
      this.report.packagesWithScripts = packagesWithScripts.length;

      console.error(`Found ${packagesWithScripts.length} package(s) with install scripts\n`);

      // Analyze each package
      for (const pkg of packagesWithScripts) {
        console.error(`Analyzing ${pkg.name}@${pkg.version}...`);
        await this.analyzePackage(pkg);
      }

      // Calculate flagged packages
      this.report.flaggedPackages = this.report.packages.filter(p => p.flagged).length;

      // Output report
      this.outputReport();

      return this.report;

    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Parse package-lock.json
   */
  parseLockfile() {
    if (!fs.existsSync(this.lockfilePath)) {
      throw new Error('package-lock.json not found');
    }

    const content = fs.readFileSync(this.lockfilePath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Find packages with hasInstallScript: true
   */
  findPackagesWithInstallScripts(lockfile) {
    const packages = [];
    const nodes = lockfile.packages || {};

    this.report.totalPackages = Object.keys(nodes).length;

    for (const [packagePath, packageData] of Object.entries(nodes)) {
      // Skip root package
      if (packagePath === '') continue;

      if (packageData.hasInstallScript === true) {
        // Extract package name from path (remove node_modules/)
        const name = packagePath.replace(/^node_modules\//, '');
        packages.push({
          name: name,
          version: packageData.version,
          resolved: packageData.resolved,
          path: packagePath
        });
      }
    }

    return packages;
  }

  /**
   * Fetch package.json from npm registry
   */
  async fetchPackageJson(name, version) {
    // Handle scoped packages
    const encodedName = name.replace('/', '%2F');
    const url = `https://registry.npmjs.org/${encodedName}/${version}`;

    return new Promise((resolve, reject) => {
      const timeoutMs = 10000; // 10 second timeout
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout fetching ${name}@${version}`));
      }, timeoutMs);

      https.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse JSON for ${name}@${version}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${name}@${version}`));
          }
        });
      }).on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Analyze a package for suspicious install scripts
   */
  async analyzePackage(pkg) {
    const packageResult = {
      name: pkg.name,
      version: pkg.version,
      whitelisted: this.whitelist.has(pkg.name),
      scripts: {},
      findings: [],
      riskLevel: 'low',
      flagged: false,
      error: null
    };

    try {
      // Fetch package.json from registry
      const packageJson = await this.fetchPackageJson(pkg.name, pkg.version);

      // Extract install scripts
      const scripts = packageJson.scripts || {};
      const installScripts = ['preinstall', 'install', 'postinstall'];

      for (const scriptName of installScripts) {
        if (scripts[scriptName]) {
          packageResult.scripts[scriptName] = scripts[scriptName];
        }
      }

      // If no scripts found, mark as error
      if (Object.keys(packageResult.scripts).length === 0) {
        packageResult.error = 'hasInstallScript flag set but no install scripts found in package.json';
      } else {
        // Analyze script contents
        this.analyzeScriptContents(packageResult);
      }

    } catch (error) {
      packageResult.error = error.message;
      console.error(`  ⚠️  Failed to fetch: ${error.message}`);
    }

    // Determine if package should be flagged
    if (!packageResult.whitelisted && packageResult.findings.length > 0) {
      packageResult.flagged = true;
    }

    this.report.packages.push(packageResult);

    // Output summary
    if (packageResult.flagged) {
      const riskEmoji = this.getRiskEmoji(packageResult.riskLevel);
      console.error(`  ${riskEmoji} FLAGGED - ${packageResult.riskLevel.toUpperCase()} risk (${packageResult.findings.length} finding(s))`);
    } else if (packageResult.whitelisted) {
      console.error(`  ✅ Whitelisted`);
    } else if (packageResult.error) {
      console.error(`  ⚠️  Error analyzing package`);
    } else {
      console.error(`  ✓ No suspicious patterns detected`);
    }
  }

  /**
   * Analyze script contents for suspicious patterns
   */
  analyzeScriptContents(packageResult) {
    const findings = [];
    const scripts = packageResult.scripts;

    for (const [scriptName, scriptContent] of Object.entries(scripts)) {
      // Check for legitimate patterns first
      const hasLegitimatePattern = LEGITIMATE_PATTERNS.some(pattern => 
        pattern.test(scriptContent)
      );

      // Scan for suspicious patterns
      for (const suspiciousPattern of SUSPICIOUS_PATTERNS) {
        if (suspiciousPattern.pattern.test(scriptContent)) {
          findings.push({
            script: scriptName,
            pattern: suspiciousPattern.name,
            description: suspiciousPattern.description,
            risk: suspiciousPattern.risk,
            snippet: this.extractSnippet(scriptContent, suspiciousPattern.pattern),
            mitigated: hasLegitimatePattern
          });
        }
      }
    }

    packageResult.findings = findings;

    // Calculate overall risk level
    packageResult.riskLevel = this.calculateRiskLevel(findings);
  }

  /**
   * Extract a snippet of code matching the pattern
   */
  extractSnippet(content, pattern) {
    const match = content.match(pattern);
    if (!match) return '';

    const index = match.index;
    const start = Math.max(0, index - 20);
    const end = Math.min(content.length, index + match[0].length + 20);
    
    let snippet = content.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';
    
    return snippet;
  }

  /**
   * Calculate overall risk level based on findings
   */
  calculateRiskLevel(findings) {
    if (findings.length === 0) return 'low';

    const hasCritical = findings.some(f => f.risk === 'critical' && !f.mitigated);
    const hasHigh = findings.some(f => f.risk === 'high' && !f.mitigated);
    const hasMedium = findings.some(f => f.risk === 'medium' && !f.mitigated);

    if (hasCritical) return 'critical';
    if (hasHigh) return 'high';
    if (hasMedium) return 'medium';
    return 'low';
  }

  /**
   * Get risk emoji
   */
  getRiskEmoji(riskLevel) {
    const emojis = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢'
    };
    return emojis[riskLevel] || '⚪';
  }

  /**
   * Output JSON report
   */
  outputReport() {
    console.log(JSON.stringify(this.report, null, 2));
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const options = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lockfile' && args[i + 1]) {
      options.lockfilePath = args[i + 1];
      i++;
    } else if (args[i] === '--whitelist' && args[i + 1]) {
      options.whitelist = args[i + 1].split(',');
      i++;
    }
  }

  const detector = new InstallScriptDetector(options);
  await detector.detect();
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  InstallScriptDetector,
  SUSPICIOUS_PATTERNS,
  WHITELIST
};
