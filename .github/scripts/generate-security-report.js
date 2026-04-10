#!/usr/bin/env node

/**
 * Supply Chain Security Report Generator
 * 
 * Aggregates findings from all security checks and generates:
 * - Workflow summary (GITHUB_STEP_SUMMARY)
 * - PR comments (if applicable)
 * - GitHub Actions annotations
 * - Exit code based on severity
 */

const fs = require('fs');
const path = require('path');

// Severity levels for findings
const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info'
};

// Emoji mappings for visual clarity
const EMOJI = {
  [SEVERITY.CRITICAL]: '🔴',
  [SEVERITY.HIGH]: '🟠',
  [SEVERITY.MEDIUM]: '🟡',
  [SEVERITY.LOW]: '🔵',
  [SEVERITY.INFO]: '✅',
  pass: '✅',
  warning: '⚠️',
  fail: '❌',
  security: '🔒',
  package: '📦',
  lock: '🔐',
  script: '⚙️',
  audit: '🔍'
};

class SecurityReportGenerator {
  constructor() {
    this.findings = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: []
    };
    this.checks = {
      passed: [],
      warnings: [],
      failed: []
    };
    this.summary = {
      totalChecks: 0,
      passedChecks: 0,
      warningChecks: 0,
      failedChecks: 0,
      criticalFindings: 0,
      highFindings: 0,
      mediumFindings: 0,
      lowFindings: 0
    };
    this.recommendations = [];
  }

  /**
   * Load and aggregate all security check results
   */
  async aggregateResults() {
    console.log('📊 Aggregating security check results...\n');

    // Load dependency changes
    await this.loadDependencyChanges();

    // Load typosquatting report
    await this.loadTyposquattingReport();

    // Load lockfile verification report
    await this.loadLockfileReport();

    // Load install scripts report (if exists)
    await this.loadInstallScriptsReport();

    // Load npm audit report (if exists)
    await this.loadAuditReport();

    // Calculate summary statistics
    this.calculateSummary();
  }

  /**
   * Load dependency changes report
   */
  async loadDependencyChanges() {
    const reportPath = 'dependency-changes.json';
    if (!fs.existsSync(reportPath)) {
      console.log('⚠️  Dependency changes report not found, skipping...');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const totalChanges = data.added.length + data.removed.length + data.modified.length;

      if (totalChanges === 0) {
        this.checks.passed.push({
          name: 'Dependency Changes',
          message: 'No dependency changes detected'
        });
      } else {
        this.checks.info = this.checks.info || [];
        this.checks.info.push({
          name: 'Dependency Changes',
          message: `${data.added.length} added, ${data.removed.length} removed, ${data.modified.length} modified`
        });

        // Flag newly added dependencies for review
        if (data.added.length > 0) {
          this.findings.info.push({
            category: 'Dependency Changes',
            title: `${data.added.length} new dependencies added`,
            details: data.added.map(dep => `${dep.name}@${dep.version} (${dep.type})`),
            recommendation: 'Review new dependencies for legitimacy and necessity'
          });
        }
      }

      this.summary.totalChecks++;
    } catch (error) {
      console.error(`Error loading dependency changes: ${error.message}`);
    }
  }

  /**
   * Load typosquatting detection report
   */
  async loadTyposquattingReport() {
    const reportPath = 'typosquatting-report.json';
    if (!fs.existsSync(reportPath)) {
      console.log('⚠️  Typosquatting report not found, skipping...');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const flaggedPackages = data.results.filter(r => r.risks.length > 0);

      if (flaggedPackages.length === 0) {
        this.checks.passed.push({
          name: 'Typosquatting Detection',
          message: 'No potential typosquatting detected'
        });
      } else {
        this.checks.failed.push({
          name: 'Typosquatting Detection',
          message: `${flaggedPackages.length} potentially suspicious packages found`
        });

        // Categorize by risk level
        flaggedPackages.forEach(pkg => {
          const severity = pkg.overallRisk === 'high' ? SEVERITY.HIGH : SEVERITY.MEDIUM;
          
          this.findings[severity].push({
            category: 'Typosquatting',
            title: `Suspicious package: ${pkg.package}`,
            severity: pkg.overallRisk,
            details: pkg.risks.map(r => `${r.type}: ${r.reason}`),
            recommendation: 'Verify this package is legitimate before proceeding. Check npm registry, GitHub repository, and recent downloads.',
            annotations: [{
              file: 'package.json',
              message: `Potential typosquatting: ${pkg.package} (${pkg.overallRisk} risk)`
            }]
          });
        });
      }

      this.summary.totalChecks++;
    } catch (error) {
      console.error(`Error loading typosquatting report: ${error.message}`);
    }
  }

  /**
   * Load lockfile integrity report
   */
  async loadLockfileReport() {
    const reportPath = 'lockfile-verification-report.json';
    if (!fs.existsSync(reportPath)) {
      console.log('⚠️  Lockfile verification report not found, skipping...');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

      if (data.status === 'pass') {
        this.checks.passed.push({
          name: 'Lockfile Integrity',
          message: 'Lockfile integrity verification passed'
        });
      } else {
        this.checks.failed.push({
          name: 'Lockfile Integrity',
          message: `Lockfile integrity verification failed with ${data.errors.length} errors`
        });
      }

      // Process errors
      data.errors.forEach(error => {
        const severity = this.getLockfileErrorSeverity(error.check);
        
        this.findings[severity].push({
          category: 'Lockfile Integrity',
          title: error.check.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          details: [error.message],
          recommendation: this.getLockfileRecommendation(error.check),
          annotations: [{
            file: 'package-lock.json',
            message: error.message
          }]
        });
      });

      // Process warnings
      data.warnings.forEach(warning => {
        this.findings.low.push({
          category: 'Lockfile Integrity',
          title: warning.check.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          details: [warning.message],
          recommendation: 'Review and address if necessary'
        });
      });

      this.summary.totalChecks++;
    } catch (error) {
      console.error(`Error loading lockfile report: ${error.message}`);
    }
  }

  /**
   * Load install scripts analysis report
   */
  async loadInstallScriptsReport() {
    const reportPath = 'install-scripts-report.json';
    if (!fs.existsSync(reportPath)) {
      console.log('⚠️  Install scripts report not found, skipping...');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      
      if (data.packagesWithScripts === 0) {
        this.checks.passed.push({
          name: 'Install Scripts',
          message: 'No install scripts found'
        });
      } else {
        const suspiciousCount = data.suspiciousScripts ? data.suspiciousScripts.length : 0;
        
        if (suspiciousCount > 0) {
          this.checks.failed.push({
            name: 'Install Scripts',
            message: `${suspiciousCount} suspicious install scripts detected`
          });

          // Process suspicious scripts
          data.suspiciousScripts.forEach(script => {
            this.findings.critical.push({
              category: 'Install Scripts',
              title: `Suspicious install script in ${script.package}`,
              details: [
                `Script: ${script.script}`,
                `Reason: ${script.reason}`,
                ...script.indicators.map(i => `⚠️ ${i}`)
              ],
              recommendation: 'DO NOT INSTALL. This package contains potentially malicious install scripts. Remove this package immediately.',
              annotations: [{
                file: 'package.json',
                message: `CRITICAL: Suspicious install script in ${script.package}`
              }]
            });
          });
        } else {
          this.checks.warnings.push({
            name: 'Install Scripts',
            message: `${data.packagesWithScripts} packages have install scripts (review recommended)`
          });

          // Add informational finding
          this.findings.low.push({
            category: 'Install Scripts',
            title: `${data.packagesWithScripts} packages with install scripts`,
            details: data.packages ? data.packages.map(p => `${p.name}: ${p.scripts.join(', ')}`) : [],
            recommendation: 'Review install scripts to ensure they are legitimate and necessary'
          });
        }
      }

      this.summary.totalChecks++;
    } catch (error) {
      console.error(`Error loading install scripts report: ${error.message}`);
    }
  }

  /**
   * Load npm audit report
   */
  async loadAuditReport() {
    const reportPath = 'audit-report.json';
    if (!fs.existsSync(reportPath)) {
      console.log('⚠️  Audit report not found, skipping...');
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      
      const vulnerabilities = data.metadata?.vulnerabilities || {};
      const total = vulnerabilities.total || 0;

      if (total === 0) {
        this.checks.passed.push({
          name: 'npm audit',
          message: 'No known vulnerabilities found'
        });
      } else {
        const critical = vulnerabilities.critical || 0;
        const high = vulnerabilities.high || 0;
        const moderate = vulnerabilities.moderate || 0;
        const low = vulnerabilities.low || 0;

        this.checks.failed.push({
          name: 'npm audit',
          message: `${total} vulnerabilities found (${critical} critical, ${high} high, ${moderate} moderate, ${low} low)`
        });

        // Process vulnerabilities
        if (critical > 0) {
          this.findings.critical.push({
            category: 'npm audit',
            title: `${critical} critical vulnerabilities`,
            details: ['Run `npm audit` for details'],
            recommendation: 'Update vulnerable packages immediately with `npm audit fix` or manually update affected packages'
          });
        }

        if (high > 0) {
          this.findings.high.push({
            category: 'npm audit',
            title: `${high} high severity vulnerabilities`,
            details: ['Run `npm audit` for details'],
            recommendation: 'Update vulnerable packages with `npm audit fix` or review alternatives'
          });
        }

        if (moderate > 0 || low > 0) {
          this.findings.medium.push({
            category: 'npm audit',
            title: `${moderate + low} moderate/low severity vulnerabilities`,
            details: ['Run `npm audit` for details'],
            recommendation: 'Review and update when possible'
          });
        }
      }

      this.summary.totalChecks++;
    } catch (error) {
      console.error(`Error loading audit report: ${error.message}`);
    }
  }

  /**
   * Calculate summary statistics
   */
  calculateSummary() {
    this.summary.passedChecks = this.checks.passed.length;
    this.summary.warningChecks = this.checks.warnings.length;
    this.summary.failedChecks = this.checks.failed.length;
    
    this.summary.criticalFindings = this.findings.critical.length;
    this.summary.highFindings = this.findings.high.length;
    this.summary.mediumFindings = this.findings.medium.length;
    this.summary.lowFindings = this.findings.low.length;
  }

  /**
   * Generate Markdown report
   */
  generateMarkdown() {
    let markdown = '';

    // Header
    markdown += `# ${EMOJI.security} Supply Chain Security Report\n\n`;
    markdown += `*Generated at ${new Date().toISOString()}*\n\n`;

    // Summary section
    markdown += '## 📊 Summary\n\n';
    
    const totalFindings = this.summary.criticalFindings + this.summary.highFindings + 
                         this.summary.mediumFindings + this.summary.lowFindings;
    
    if (this.summary.criticalFindings > 0) {
      markdown += `### ${EMOJI.fail} Status: FAILED\n\n`;
      markdown += `**Critical issues found! Do not merge until resolved.**\n\n`;
    } else if (this.summary.highFindings > 0) {
      markdown += `### ${EMOJI.warning} Status: REVIEW REQUIRED\n\n`;
      markdown += `**High-severity issues require review before merging.**\n\n`;
    } else if (this.summary.failedChecks > 0) {
      markdown += `### ${EMOJI.warning} Status: WARNINGS\n\n`;
      markdown += `**Some checks failed but no critical issues found.**\n\n`;
    } else {
      markdown += `### ${EMOJI.pass} Status: PASSED\n\n`;
      markdown += `**All security checks passed!**\n\n`;
    }

    // Checks overview
    markdown += '| Metric | Count |\n';
    markdown += '|--------|-------|\n';
    markdown += `| Total Checks | ${this.summary.totalChecks} |\n`;
    markdown += `| ${EMOJI.pass} Passed | ${this.summary.passedChecks} |\n`;
    markdown += `| ${EMOJI.warning} Warnings | ${this.summary.warningChecks} |\n`;
    markdown += `| ${EMOJI.fail} Failed | ${this.summary.failedChecks} |\n`;
    markdown += `| **Total Findings** | **${totalFindings}** |\n`;
    
    if (this.summary.criticalFindings > 0) {
      markdown += `| ${EMOJI.critical} Critical | ${this.summary.criticalFindings} |\n`;
    }
    if (this.summary.highFindings > 0) {
      markdown += `| ${EMOJI.high} High | ${this.summary.highFindings} |\n`;
    }
    if (this.summary.mediumFindings > 0) {
      markdown += `| ${EMOJI.medium} Medium | ${this.summary.mediumFindings} |\n`;
    }
    if (this.summary.lowFindings > 0) {
      markdown += `| ${EMOJI.low} Low/Info | ${this.summary.lowFindings} |\n`;
    }
    markdown += '\n';

    // Detailed findings by severity
    if (totalFindings > 0) {
      markdown += '## 🔍 Findings\n\n';

      // Critical findings
      if (this.findings.critical.length > 0) {
        markdown += `### ${EMOJI.critical} Critical Issues\n\n`;
        markdown += '**These issues must be resolved before merging!**\n\n';
        this.findings.critical.forEach((finding, idx) => {
          markdown += this.formatFinding(finding, idx + 1);
        });
      }

      // High findings
      if (this.findings.high.length > 0) {
        markdown += `### ${EMOJI.high} High Priority Issues\n\n`;
        markdown += '**These issues require immediate attention.**\n\n';
        this.findings.high.forEach((finding, idx) => {
          markdown += this.formatFinding(finding, idx + 1);
        });
      }

      // Medium findings
      if (this.findings.medium.length > 0) {
        markdown += `### ${EMOJI.medium} Medium Priority Issues\n\n`;
        this.findings.medium.forEach((finding, idx) => {
          markdown += this.formatFinding(finding, idx + 1);
        });
      }

      // Low/Info findings
      if (this.findings.low.length > 0 || this.findings.info.length > 0) {
        markdown += `### ${EMOJI.low} Informational\n\n`;
        [...this.findings.low, ...this.findings.info].forEach((finding, idx) => {
          markdown += this.formatFinding(finding, idx + 1);
        });
      }
    }

    // Passed checks
    if (this.checks.passed.length > 0) {
      markdown += '## ✅ Passed Checks\n\n';
      this.checks.passed.forEach(check => {
        markdown += `- **${check.name}**: ${check.message}\n`;
      });
      markdown += '\n';
    }

    // Recommendations
    if (this.summary.criticalFindings > 0 || this.summary.highFindings > 0) {
      markdown += '## 💡 Recommendations\n\n';
      
      if (this.summary.criticalFindings > 0) {
        markdown += '1. **DO NOT MERGE** this pull request until all critical issues are resolved\n';
        markdown += '2. Remove or replace any packages flagged as suspicious\n';
        markdown += '3. Review all install scripts for malicious behavior\n';
      } else if (this.summary.highFindings > 0) {
        markdown += '1. Review all high-priority findings before merging\n';
        markdown += '2. Verify legitimacy of flagged packages\n';
        markdown += '3. Update vulnerable dependencies\n';
      }
      
      markdown += '4. Run `npm audit` locally for detailed vulnerability information\n';
      markdown += '5. Consider using `npm audit fix` to automatically update vulnerable dependencies\n';
      markdown += '\n';
    }

    // Footer
    markdown += '---\n\n';
    markdown += '*This report was automatically generated by the Supply Chain Security workflow.*\n';

    return markdown;
  }

  /**
   * Format a single finding for markdown
   */
  formatFinding(finding, index) {
    let md = `#### ${index}. ${finding.title}\n\n`;
    
    if (finding.category) {
      md += `**Category:** ${finding.category}\n\n`;
    }

    if (finding.details && finding.details.length > 0) {
      md += '**Details:**\n';
      finding.details.slice(0, 10).forEach(detail => {
        md += `- ${detail}\n`;
      });
      if (finding.details.length > 10) {
        md += `- *(${finding.details.length - 10} more...)*\n`;
      }
      md += '\n';
    }

    if (finding.recommendation) {
      md += `**Recommendation:** ${finding.recommendation}\n\n`;
    }

    return md;
  }

  /**
   * Write report to GitHub Step Summary
   */
  writeToStepSummary(markdown) {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    
    if (!summaryFile) {
      console.log('⚠️  GITHUB_STEP_SUMMARY not set, skipping step summary');
      return;
    }

    try {
      fs.appendFileSync(summaryFile, markdown);
      console.log('✅ Report written to workflow summary');
    } catch (error) {
      console.error(`Error writing to step summary: ${error.message}`);
    }
  }

  /**
   * Post PR comment
   */
  async postPRComment(markdown) {
    // Check if this is a PR event
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (eventName !== 'pull_request') {
      console.log('ℹ️  Not a pull request event, skipping PR comment');
      return;
    }

    // This will be handled by the GitHub Actions workflow using github-script
    // We'll save the markdown to a file for the workflow to use
    try {
      fs.writeFileSync('security-report.md', markdown);
      console.log('✅ Report saved for PR comment');
    } catch (error) {
      console.error(`Error saving report for PR comment: ${error.message}`);
    }
  }

  /**
   * Create GitHub Actions annotations
   */
  createAnnotations() {
    const allFindings = [
      ...this.findings.critical,
      ...this.findings.high,
      ...this.findings.medium
    ];

    allFindings.forEach(finding => {
      if (finding.annotations) {
        finding.annotations.forEach(annotation => {
          const level = this.getSeverityLevel(finding);
          const message = annotation.message || finding.title;
          const file = annotation.file || 'package.json';
          
          console.log(`::${level} file=${file}::${message}`);
        });
      }
    });

    console.log('✅ Annotations created');
  }

  /**
   * Get GitHub Actions annotation level from severity
   */
  getSeverityLevel(finding) {
    if (this.findings.critical.includes(finding)) {
      return 'error';
    } else if (this.findings.high.includes(finding)) {
      return 'warning';
    }
    return 'notice';
  }

  /**
   * Determine exit code based on findings
   */
  getExitCode() {
    // Exit with error if critical issues found
    if (this.summary.criticalFindings > 0) {
      console.log('\n❌ Critical issues found - exiting with error code');
      return 1;
    }

    // Exit with error if high-risk typosquatting found
    const highRiskTypo = this.findings.high.some(f => f.category === 'Typosquatting');
    if (highRiskTypo) {
      console.log('\n❌ High-risk typosquatting detected - exiting with error code');
      return 1;
    }

    // Otherwise pass
    console.log('\n✅ Security checks completed');
    return 0;
  }

  /**
   * Get lockfile error severity
   */
  getLockfileErrorSeverity(check) {
    switch (check) {
      case 'lockfile_exists':
      case 'lockfile_parse':
      case 'npm_ci_dry_run':
        return SEVERITY.HIGH;
      case 'lockfile_version':
      case 'integrity_checksums':
      case 'checksum_format':
        return SEVERITY.MEDIUM;
      default:
        return SEVERITY.LOW;
    }
  }

  /**
   * Get recommendation for lockfile errors
   */
  getLockfileRecommendation(check) {
    switch (check) {
      case 'npm_ci_dry_run':
        return 'Run `npm install` to synchronize package-lock.json with package.json';
      case 'lockfile_version':
        return 'Upgrade to npm 7+ and regenerate lockfile with `rm package-lock.json && npm install`';
      case 'integrity_checksums':
        return 'Regenerate lockfile with `rm package-lock.json && npm install` to ensure all packages have integrity checksums';
      case 'checksum_format':
        return 'Regenerate lockfile with a current version of npm';
      default:
        return 'Review and address the lockfile issue';
    }
  }

  /**
   * Save full report as JSON
   */
  saveJsonReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: this.summary,
      checks: this.checks,
      findings: this.findings
    };

    try {
      fs.writeFileSync('security-report.json', JSON.stringify(report, null, 2));
      console.log('✅ Full JSON report saved to security-report.json');
    } catch (error) {
      console.error(`Error saving JSON report: ${error.message}`);
    }
  }

  /**
   * Main execution
   */
  async run() {
    console.log('🔒 Supply Chain Security Report Generator\n');

    // Aggregate all results
    await this.aggregateResults();

    // Generate markdown report
    const markdown = this.generateMarkdown();

    // Output to console
    console.log('\n' + markdown);

    // Write to GitHub Step Summary
    this.writeToStepSummary(markdown);

    // Save for PR comment
    await this.postPRComment(markdown);

    // Create annotations
    this.createAnnotations();

    // Save JSON report
    this.saveJsonReport();

    // Exit with appropriate code
    const exitCode = this.getExitCode();
    process.exit(exitCode);
  }
}

// Run the report generator
const generator = new SecurityReportGenerator();
generator.run().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
