#!/usr/bin/env node

/**
 * Lockfile Integrity Verification Script
 * 
 * This script verifies the integrity of package-lock.json by:
 * 1. Checking lockfile version (npm 7+ = v3)
 * 2. Validating integrity checksums for all dependencies
 * 3. Verifying checksum format (base64 SHA-512)
 * 4. Running npm ci --dry-run to check consistency
 * 5. Detecting manual modifications without package.json changes
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

class LockfileVerifier {
  constructor() {
    this.lockfilePath = path.join(process.cwd(), 'package-lock.json');
    this.packageJsonPath = path.join(process.cwd(), 'package.json');
    this.report = {
      timestamp: new Date().toISOString(),
      status: 'pass',
      checks: {},
      errors: [],
      warnings: [],
    };
  }

  /**
   * Main verification function
   */
  async verify() {
    console.log(`${colors.blue}🔍 Verifying lockfile integrity...${colors.reset}\n`);

    try {
      // Step 1: Verify lockfile exists
      this.checkLockfileExists();

      // Step 2: Parse lockfile
      const lockfile = this.parseLockfile();

      // Step 3: Verify lockfile version
      this.verifyLockfileVersion(lockfile);

      // Step 4: Verify integrity checksums
      this.verifyIntegrityChecksums(lockfile);

      // Step 5: Validate checksum format
      this.validateChecksumFormat(lockfile);

      // Step 6: Run npm ci --dry-run
      this.runNpmCiDryRun();

      // Step 7: Check for manual modifications
      this.checkManualModifications();

      // Final status
      if (this.report.errors.length === 0) {
        this.report.status = 'pass';
        console.log(`\n${colors.green}✓ All lockfile integrity checks passed!${colors.reset}\n`);
      } else {
        this.report.status = 'fail';
        console.log(`\n${colors.red}✗ Lockfile integrity verification failed!${colors.reset}\n`);
      }

      // Output JSON report
      this.outputReport();

      // Exit with appropriate code
      process.exit(this.report.status === 'pass' ? 0 : 1);

    } catch (error) {
      this.report.status = 'error';
      this.report.errors.push({
        check: 'general',
        message: error.message,
      });
      console.error(`${colors.red}✗ Fatal error: ${error.message}${colors.reset}\n`);
      this.outputReport();
      process.exit(1);
    }
  }

  /**
   * Check if lockfile exists
   */
  checkLockfileExists() {
    console.log('📄 Checking lockfile exists...');
    if (!fs.existsSync(this.lockfilePath)) {
      this.addError('lockfile_exists', 'package-lock.json not found');
      throw new Error('package-lock.json not found');
    }
    this.addCheck('lockfile_exists', true, 'package-lock.json found');
  }

  /**
   * Parse lockfile JSON
   */
  parseLockfile() {
    console.log('📖 Parsing lockfile...');
    try {
      const content = fs.readFileSync(this.lockfilePath, 'utf-8');
      const lockfile = JSON.parse(content);
      this.addCheck('lockfile_parse', true, 'Successfully parsed lockfile');
      return lockfile;
    } catch (error) {
      this.addError('lockfile_parse', `Failed to parse lockfile: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify lockfile version is 3 (npm 7+)
   */
  verifyLockfileVersion(lockfile) {
    console.log('🔢 Verifying lockfile version...');
    const version = lockfile.lockfileVersion;
    
    if (version !== 3) {
      this.addError(
        'lockfile_version',
        `Lockfile version is ${version}, expected 3 (npm 7+)`
      );
    } else {
      this.addCheck(
        'lockfile_version',
        true,
        `Lockfile version is ${version} (npm 7+ format)`
      );
    }
  }

  /**
   * Verify all dependencies have integrity checksums
   */
  verifyIntegrityChecksums(lockfile) {
    console.log('🔐 Verifying integrity checksums...');
    
    const packages = lockfile.packages || {};
    let totalPackages = 0;
    let packagesWithIntegrity = 0;
    const missingIntegrity = [];

    for (const [packagePath, packageData] of Object.entries(packages)) {
      // Skip root package (empty string key)
      if (packagePath === '') continue;
      
      totalPackages++;
      
      if (packageData.integrity) {
        packagesWithIntegrity++;
      } else if (!packageData.link) {
        // Only report missing integrity for non-linked packages
        missingIntegrity.push(packagePath);
      }
    }

    if (missingIntegrity.length > 0) {
      this.addError(
        'integrity_checksums',
        `${missingIntegrity.length} packages missing integrity checksums`,
        { missingPackages: missingIntegrity.slice(0, 10) } // Show first 10
      );
    } else {
      this.addCheck(
        'integrity_checksums',
        true,
        `All ${packagesWithIntegrity} packages have integrity checksums`
      );
    }
  }

  /**
   * Validate checksum format (base64 SHA-512)
   */
  validateChecksumFormat(lockfile) {
    console.log('✅ Validating checksum format...');
    
    const packages = lockfile.packages || {};
    const invalidChecksums = [];
    
    // SHA-512 in base64 format should match: sha512-[base64 chars]
    const sha512Regex = /^sha512-[A-Za-z0-9+/]+=*$/;
    // Also accept sha1 for legacy packages (npm may still use this for some packages)
    const sha1Regex = /^sha1-[A-Za-z0-9+/]+=*$/;

    for (const [packagePath, packageData] of Object.entries(packages)) {
      if (packagePath === '' || packageData.link) continue;
      
      if (packageData.integrity) {
        const integrity = packageData.integrity;
        
        // Check if it's a valid SHA-512 or SHA-1 format
        if (!sha512Regex.test(integrity) && !sha1Regex.test(integrity)) {
          invalidChecksums.push({
            package: packagePath,
            integrity: integrity,
          });
        }
      }
    }

    if (invalidChecksums.length > 0) {
      this.addError(
        'checksum_format',
        `${invalidChecksums.length} packages have invalid checksum format`,
        { invalidPackages: invalidChecksums.slice(0, 10) }
      );
    } else {
      this.addCheck(
        'checksum_format',
        true,
        'All checksums have valid format (SHA-512/SHA-1 base64)'
      );
    }
  }

  /**
   * Run npm ci --dry-run to verify lockfile consistency
   */
  runNpmCiDryRun() {
    console.log('🔄 Running npm ci --dry-run...');
    
    try {
      // Run npm ci --dry-run to check if lockfile is in sync with package.json
      execSync('npm ci --dry-run', {
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      
      this.addCheck(
        'npm_ci_dry_run',
        true,
        'Lockfile is consistent with package.json'
      );
    } catch (error) {
      this.addError(
        'npm_ci_dry_run',
        'Lockfile is inconsistent with package.json - run `npm install` to fix',
        { 
          stderr: error.stderr ? error.stderr.toString().slice(0, 500) : '',
          stdout: error.stdout ? error.stdout.toString().slice(0, 500) : '',
        }
      );
    }
  }

  /**
   * Check for manual modifications to lockfile without package.json changes
   */
  checkManualModifications() {
    console.log('🕵️  Checking for manual modifications...');
    
    try {
      // Check if we're in a git repository
      try {
        execSync('git rev-parse --git-dir', { stdio: 'pipe' });
      } catch {
        this.addWarning(
          'manual_modifications',
          'Not a git repository - skipping manual modification check'
        );
        return;
      }

      // Get the last commit that modified package-lock.json
      let lockfileCommit;
      try {
        lockfileCommit = execSync(
          'git log -1 --format=%H -- package-lock.json',
          { encoding: 'utf-8' }
        ).trim();
      } catch {
        // File not tracked yet
        this.addCheck(
          'manual_modifications',
          true,
          'package-lock.json not yet committed'
        );
        return;
      }

      if (!lockfileCommit) {
        this.addCheck(
          'manual_modifications',
          true,
          'package-lock.json not yet committed'
        );
        return;
      }

      // Get the last commit that modified package.json
      let packageJsonCommit;
      try {
        packageJsonCommit = execSync(
          'git log -1 --format=%H -- package.json',
          { encoding: 'utf-8' }
        ).trim();
      } catch {
        packageJsonCommit = '';
      }

      // Check if package-lock.json was modified more recently than package.json
      if (lockfileCommit && packageJsonCommit && lockfileCommit !== packageJsonCommit) {
        // Get commit timestamps
        const lockfileTime = execSync(
          `git log -1 --format=%ct ${lockfileCommit}`,
          { encoding: 'utf-8' }
        ).trim();
        
        const packageJsonTime = execSync(
          `git log -1 --format=%ct ${packageJsonCommit}`,
          { encoding: 'utf-8' }
        ).trim();

        if (parseInt(lockfileTime) > parseInt(packageJsonTime)) {
          this.addWarning(
            'manual_modifications',
            'package-lock.json was modified more recently than package.json - this may indicate manual modification',
            {
              lockfileCommit: lockfileCommit.slice(0, 8),
              packageJsonCommit: packageJsonCommit.slice(0, 8),
            }
          );
        } else {
          this.addCheck(
            'manual_modifications',
            true,
            'No suspicious manual modifications detected'
          );
        }
      } else {
        this.addCheck(
          'manual_modifications',
          true,
          'Lockfile modifications appear legitimate'
        );
      }
    } catch (error) {
      this.addWarning(
        'manual_modifications',
        `Could not check manual modifications: ${error.message}`
      );
    }
  }

  /**
   * Add a successful check to the report
   */
  addCheck(name, passed, message, details = null) {
    this.report.checks[name] = {
      passed,
      message,
      ...(details && { details }),
    };
    
    const symbol = passed ? '✓' : '✗';
    const color = passed ? colors.green : colors.red;
    console.log(`  ${color}${symbol} ${message}${colors.reset}`);
  }

  /**
   * Add an error to the report
   */
  addError(check, message, details = null) {
    this.report.errors.push({
      check,
      message,
      ...(details && { details }),
    });
    
    this.report.checks[check] = {
      passed: false,
      message,
      ...(details && { details }),
    };
    
    console.log(`  ${colors.red}✗ ${message}${colors.reset}`);
  }

  /**
   * Add a warning to the report
   */
  addWarning(check, message, details = null) {
    this.report.warnings.push({
      check,
      message,
      ...(details && { details }),
    });
    
    this.report.checks[check] = {
      passed: true,
      warning: true,
      message,
      ...(details && { details }),
    };
    
    console.log(`  ${colors.yellow}⚠ ${message}${colors.reset}`);
  }

  /**
   * Output JSON report
   */
  outputReport() {
    const reportPath = path.join(process.cwd(), 'lockfile-verification-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(this.report, null, 2));
    console.log(`\n📊 Report saved to: ${reportPath}`);
    
    // Also output to console for CI
    console.log('\n📋 Verification Report:');
    console.log(JSON.stringify(this.report, null, 2));
  }
}

// Run the verifier
const verifier = new LockfileVerifier();
verifier.verify().catch((error) => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});
