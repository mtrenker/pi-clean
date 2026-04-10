#!/usr/bin/env node

/**
 * Typosquatting Detection Script
 * Analyzes package names for potential typosquatting attacks
 */

const POPULAR_PACKAGES = [
  'react', 'lodash', 'express', 'axios', 'moment', 'typescript',
  'webpack', 'eslint', 'prettier', 'jest', 'chalk', 'commander',
  'request', 'async', 'dotenv', 'debug', 'uuid', 'node-fetch',
  'colors', 'inquirer', 'yargs', 'validator', 'cors', 'bcrypt',
  'jsonwebtoken', 'mongoose', 'pg', 'redis', 'socket.io', 'winston',
  'morgan', 'body-parser', 'cookie-parser', 'multer', 'passport',
  'helmet', 'compression', 'serve-favicon', 'method-override',
  'errorhandler', 'express-session', 'connect-redis', 'mysql',
  'sequelize', 'knex', 'typeorm', 'prisma', 'graphql', 'apollo-server',
  'next', 'gatsby', 'vue', 'angular', 'svelte', 'nuxt',
  'vite', 'rollup', 'parcel', 'esbuild', 'babel', 'postcss',
  'sass', 'less', 'stylus', 'autoprefixer', 'tailwindcss',
  'bootstrap', 'jquery', 'underscore', 'ramda', 'rxjs',
  'immutable', 'redux', 'mobx', 'zustand', 'recoil', 'jotai',
  'react-dom', 'react-router', 'react-query', 'swr', 'formik',
  'react-hook-form', 'styled-components', 'emotion', 'material-ui',
  'antd', 'chakra-ui', 'semantic-ui', 'node', 'npm', 'yarn',
  'pnpm', 'turbo', 'lerna', 'nx', 'nodemon', 'concurrently',
  'rimraf', 'cross-env', 'husky', 'lint-staged'
];

// Common prefixes and suffixes used in combosquatting
const COMMON_PREFIXES = [
  'node-', 'js-', 'npm-', 'secure-', 'safe-', 'super-',
  'new-', 'next-', 'modern-', 'latest-', 'official-', 'original-'
];

const COMMON_SUFFIXES = [
  '-js', '-node', '-npm', '-plus', '-pro', '-secure',
  '-safe', '-new', '-next', '-modern', '-latest', '-v2', '-v3'
];

// Character substitution patterns
const CHAR_SUBSTITUTIONS = {
  'o': ['0'],
  '0': ['o'],
  'l': ['1', 'i'],
  '1': ['l', 'i'],
  'i': ['1', 'l'],
  's': ['5', '$'],
  '5': ['s'],
  'a': ['@'],
  'e': ['3'],
  '3': ['e']
};

// Homoglyphs: visually similar characters from different scripts
const HOMOGLYPHS = {
  // Cyrillic to Latin
  'а': 'a', // Cyrillic 'a'
  'е': 'e', // Cyrillic 'e'
  'о': 'o', // Cyrillic 'o'
  'р': 'p', // Cyrillic 'r'
  'с': 'c', // Cyrillic 's'
  'у': 'y', // Cyrillic 'u'
  'х': 'x', // Cyrillic 'x'
  // Greek to Latin
  'α': 'a',
  'β': 'b',
  'ε': 'e',
  'ο': 'o',
  'ρ': 'p',
  'τ': 't',
  'υ': 'y',
  'χ': 'x'
};

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = [];

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[len1][len2];
}

/**
 * Normalize homoglyphs to their Latin equivalents
 */
function normalizeHomoglyphs(str) {
  let normalized = str;
  for (const [homoglyph, latin] of Object.entries(HOMOGLYPHS)) {
    normalized = normalized.split(homoglyph).join(latin);
  }
  return normalized;
}

/**
 * Check if string contains homoglyphs
 */
function hasHomoglyphs(str) {
  for (const homoglyph of Object.keys(HOMOGLYPHS)) {
    if (str.includes(homoglyph)) {
      return true;
    }
  }
  return false;
}

/**
 * Generate possible character substitutions
 */
function generateSubstitutions(str) {
  const substitutions = new Set();
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (CHAR_SUBSTITUTIONS[char]) {
      for (const replacement of CHAR_SUBSTITUTIONS[char]) {
        const variant = str.slice(0, i) + replacement + str.slice(i + 1);
        substitutions.add(variant);
      }
    }
  }
  
  return Array.from(substitutions);
}

/**
 * Check for character substitution patterns
 */
function checkCharSubstitution(packageName, popularPackage) {
  const substitutions = generateSubstitutions(packageName);
  return substitutions.includes(popularPackage);
}

/**
 * Check for combosquatting (prefixes/suffixes)
 */
function checkCombosquatting(packageName) {
  const results = [];
  
  for (const prefix of COMMON_PREFIXES) {
    if (packageName.startsWith(prefix)) {
      const base = packageName.slice(prefix.length);
      if (POPULAR_PACKAGES.includes(base)) {
        results.push({
          type: 'prefix',
          pattern: prefix,
          base: base
        });
      }
    }
  }
  
  for (const suffix of COMMON_SUFFIXES) {
    if (packageName.endsWith(suffix)) {
      const base = packageName.slice(0, -suffix.length);
      if (POPULAR_PACKAGES.includes(base)) {
        results.push({
          type: 'suffix',
          pattern: suffix,
          base: base
        });
      }
    }
  }
  
  return results;
}

/**
 * Extract scope and package name from scoped package
 */
function parsePackageName(packageName) {
  const scopeMatch = packageName.match(/^(@[^/]+)\/(.+)$/);
  if (scopeMatch) {
    return {
      scope: scopeMatch[1],
      name: scopeMatch[2],
      isScoped: true
    };
  }
  return {
    scope: null,
    name: packageName,
    isScoped: false
  };
}

/**
 * Check for namespace squatting
 */
function checkNamespaceSquatting(packageName) {
  const parsed = parsePackageName(packageName);
  if (!parsed.isScoped) {
    return null;
  }
  
  const scope = parsed.scope;
  const name = parsed.name;
  
  // Check if the package name (without scope) is a popular package
  if (POPULAR_PACKAGES.includes(name)) {
    return {
      suspiciousScope: scope,
      packageName: name,
      reason: 'scoped version of popular unscoped package'
    };
  }
  
  // Check for similar scopes (edit distance)
  const commonScopes = [
    '@angular', '@babel', '@types', '@jest', '@testing-library',
    '@react', '@vue', '@nestjs', '@apollo', '@graphql-tools',
    '@aws-sdk', '@azure', '@google-cloud', '@stripe', '@shopify'
  ];
  
  for (const commonScope of commonScopes) {
    const distance = levenshteinDistance(scope, commonScope);
    if (distance > 0 && distance <= 2) {
      return {
        suspiciousScope: scope,
        similarTo: commonScope,
        distance: distance,
        packageName: name,
        reason: 'similar scope to popular organization'
      };
    }
  }
  
  return null;
}

/**
 * Analyze a package name for typosquatting
 */
function analyzePackage(packageName) {
  const results = {
    package: packageName,
    risks: [],
    overallRisk: 'low'
  };
  
  const parsed = parsePackageName(packageName);
  const nameToCheck = parsed.name.toLowerCase();
  
  // Check for homoglyphs first
  if (hasHomoglyphs(packageName)) {
    const normalized = normalizeHomoglyphs(packageName);
    results.risks.push({
      type: 'homoglyph',
      risk: 'high',
      reason: `Contains homoglyph characters, normalizes to: ${normalized}`
    });
  }
  
  // Check against popular packages
  for (const popular of POPULAR_PACKAGES) {
    // Skip exact matches
    if (nameToCheck === popular) {
      continue;
    }
    
    // Check Levenshtein distance
    const distance = levenshteinDistance(nameToCheck, popular);
    if (distance <= 2) {
      results.risks.push({
        type: 'edit-distance',
        risk: distance === 1 ? 'high' : 'medium',
        reason: `Edit distance of ${distance} from popular package '${popular}'`,
        similarTo: popular,
        distance: distance
      });
    }
    
    // Check character substitution
    if (checkCharSubstitution(nameToCheck, popular)) {
      results.risks.push({
        type: 'char-substitution',
        risk: 'high',
        reason: `Character substitution variant of '${popular}'`,
        similarTo: popular
      });
    }
    
    // Check normalized homoglyphs against popular packages
    const normalizedName = normalizeHomoglyphs(nameToCheck);
    if (normalizedName !== nameToCheck && normalizedName === popular) {
      results.risks.push({
        type: 'homoglyph-match',
        risk: 'high',
        reason: `Homoglyph variant of '${popular}'`,
        similarTo: popular
      });
    }
  }
  
  // Check for combosquatting
  const comboResults = checkCombosquatting(nameToCheck);
  for (const combo of comboResults) {
    results.risks.push({
      type: 'combosquatting',
      risk: 'medium',
      reason: `${combo.type} combosquatting: '${combo.pattern}' + '${combo.base}'`,
      pattern: combo.pattern,
      base: combo.base
    });
  }
  
  // Check for namespace squatting
  if (parsed.isScoped) {
    const nsSquat = checkNamespaceSquatting(packageName);
    if (nsSquat) {
      results.risks.push({
        type: 'namespace-squatting',
        risk: 'medium',
        reason: nsSquat.reason,
        details: nsSquat
      });
    }
  }
  
  // Determine overall risk
  if (results.risks.length > 0) {
    const hasHigh = results.risks.some(r => r.risk === 'high');
    const hasMedium = results.risks.some(r => r.risk === 'medium');
    
    if (hasHigh) {
      results.overallRisk = 'high';
    } else if (hasMedium) {
      results.overallRisk = 'medium';
    }
  }
  
  return results;
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: node detect-typosquatting.js <package1> <package2> ...');
    console.error('   or: echo "package1\\npackage2" | node detect-typosquatting.js');
    process.exit(1);
  }
  
  // If args contain '-', read from stdin
  let packages = args;
  if (args.length === 1 && args[0] === '-') {
    const fs = require('fs');
    const input = fs.readFileSync(0, 'utf-8');
    packages = input.trim().split('\n').filter(p => p.trim());
  }
  
  const results = packages.map(pkg => analyzePackage(pkg.trim()));
  
  // Output JSON report
  const report = {
    timestamp: new Date().toISOString(),
    totalPackages: results.length,
    flaggedPackages: results.filter(r => r.risks.length > 0).length,
    results: results
  };
  
  console.log(JSON.stringify(report, null, 2));
  
  // Exit with error code if high-risk packages found
  const hasHighRisk = results.some(r => r.overallRisk === 'high');
  if (hasHighRisk) {
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  analyzePackage,
  levenshteinDistance,
  checkCombosquatting,
  checkNamespaceSquatting,
  POPULAR_PACKAGES
};
