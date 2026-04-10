#!/usr/bin/env node

/**
 * Detect dependency changes between two git commits
 * Usage: node detect-dependency-changes.js <base-commit> <head-commit>
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node detect-dependency-changes.js <base-commit> <head-commit>');
  process.exit(1);
}

const [baseCommit, headCommit] = args;

/**
 * Get package.json content from a specific commit
 * @param {string} commit - Git commit reference
 * @returns {object|null} Parsed package.json or null if not found
 */
function getPackageJson(commit) {
  try {
    const content = execSync(`git show ${commit}:package.json`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return JSON.parse(content);
  } catch (error) {
    // File doesn't exist at this commit or commit doesn't exist
    return null;
  }
}

/**
 * Extract all dependencies from package.json
 * @param {object} packageJson - Parsed package.json
 * @returns {object} Map of dependency name to {version, type}
 */
function extractDependencies(packageJson) {
  const deps = {};
  
  if (!packageJson) {
    return deps;
  }
  
  // Process dependencies
  if (packageJson.dependencies) {
    for (const [name, version] of Object.entries(packageJson.dependencies)) {
      deps[name] = { version, type: 'dependencies' };
    }
  }
  
  // Process devDependencies
  if (packageJson.devDependencies) {
    for (const [name, version] of Object.entries(packageJson.devDependencies)) {
      deps[name] = { version, type: 'devDependencies' };
    }
  }
  
  // Process peerDependencies
  if (packageJson.peerDependencies) {
    for (const [name, version] of Object.entries(packageJson.peerDependencies)) {
      deps[name] = { version, type: 'peerDependencies' };
    }
  }
  
  // Process optionalDependencies
  if (packageJson.optionalDependencies) {
    for (const [name, version] of Object.entries(packageJson.optionalDependencies)) {
      deps[name] = { version, type: 'optionalDependencies' };
    }
  }
  
  return deps;
}

/**
 * Compare dependencies between two commits
 * @param {object} baseDeps - Dependencies from base commit
 * @param {object} headDeps - Dependencies from head commit
 * @returns {object} Changes categorized as added, removed, modified
 */
function compareDependencies(baseDeps, headDeps) {
  const changes = {
    added: [],
    removed: [],
    modified: []
  };
  
  // Find added and modified dependencies
  for (const [name, info] of Object.entries(headDeps)) {
    if (!baseDeps[name]) {
      // New dependency
      changes.added.push({
        name,
        version: info.version,
        type: info.type
      });
    } else if (baseDeps[name].version !== info.version) {
      // Version changed
      changes.modified.push({
        name,
        oldVersion: baseDeps[name].version,
        newVersion: info.version,
        type: info.type
      });
    }
    // Note: We don't track type changes (e.g., moving from dependencies to devDependencies)
    // as separate events - they show as remove + add
  }
  
  // Find removed dependencies
  for (const [name, info] of Object.entries(baseDeps)) {
    if (!headDeps[name]) {
      changes.removed.push({
        name,
        version: info.version,
        type: info.type
      });
    }
  }
  
  return changes;
}

/**
 * Main execution
 */
function main() {
  try {
    // Verify we're in a git repository
    try {
      execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    } catch (error) {
      console.error('Error: Not a git repository');
      process.exit(1);
    }
    
    // Get package.json from both commits
    const basePackageJson = getPackageJson(baseCommit);
    const headPackageJson = getPackageJson(headCommit);
    
    // Handle edge case: no package.json in either commit
    if (!basePackageJson && !headPackageJson) {
      console.log(JSON.stringify({
        added: [],
        removed: [],
        modified: []
      }, null, 2));
      process.exit(0);
    }
    
    // Extract dependencies
    const baseDeps = extractDependencies(basePackageJson);
    const headDeps = extractDependencies(headPackageJson);
    
    // Compare and output results
    const changes = compareDependencies(baseDeps, headDeps);
    
    console.log(JSON.stringify(changes, null, 2));
    process.exit(0);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
