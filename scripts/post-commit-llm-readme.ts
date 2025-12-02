#!/usr/bin/env ts-node

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Post-commit script for committing LLM readme files
 * This script runs after the main commit is complete and creates a separate commit for LLM readme files
 */

const PROJECT_ROOT = process.cwd();
const METADATA_PATH = path.join(PROJECT_ROOT, '.git', 'llm-readme-metadata.json');

interface CommitMetadata {
  timestamp: string;
  commitMessage: string;
  hasLlmReadmeFiles: boolean;
}

interface ScriptConfig {
  timeout: number; // milliseconds
  maxRetries: number;
  logLevel: 'info' | 'verbose' | 'silent';
}

const config: ScriptConfig = {
  timeout: 30000, // 30 seconds
  maxRetries: 3,
  logLevel: 'info'
};

/**
 * Logger utility ++
 */
class Logger {
  private level: string;

  constructor(level: string = 'info') {
    this.level = level;
  }

  info(message: string, ...args: any[]) {
    if (this.level !== 'silent') {
      console.log(`[POST-COMMIT] ${message}`, ...args);
    }
  }

  verbose(message: string, ...args: any[]) {
    if (this.level === 'verbose') {
      console.log(`[POST-COMMIT-VERBOSE] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]) {
    console.error(`[POST-COMMIT-ERROR] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]) {
    console.warn(`[POST-COMMIT-WARN] ${message}`, ...args);
  }

  success(message: string, ...args: any[]) {
    console.log(`[POST-COMMIT-SUCCESS] ${message}`, ...args);
  }

  highlight(message: string, ...args: any[]) {
    console.log(`>> ${message.toUpperCase()}`, ...args);
  }
}

const logger = new Logger(config.logLevel);

/**
 * Execute command with timeout and retry logic
 */
function executeCommand(command: string, options: { timeout?: number; retries?: number } = {}): string {
  const { timeout = config.timeout, retries = config.maxRetries } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.verbose(`Executing command (attempt ${attempt}/${retries}): ${command}`);

      const result = execSync(command, {
        cwd: PROJECT_ROOT,
        timeout: timeout,
        encoding: 'utf8',
        stdio: config.logLevel === 'verbose' ? 'inherit' : 'pipe'
      });

      logger.verbose(`Command executed successfully on attempt ${attempt}`);
      return result;
    } catch (error: any) {
      const isLastAttempt = attempt === retries;

      if (error.code === 'ETIMEDOUT') {
        logger.warn(`Command timed out on attempt ${attempt}/${retries}`);
      } else {
        logger.warn(`Command failed on attempt ${attempt}/${retries}: ${error.message}`);
      }

      if (isLastAttempt) {
        throw new Error(`Command failed after ${retries} attempts: ${error.message}`);
      }

      // Wait before retry (exponential backoff)
      const waitTime = Math.pow(2, attempt - 1) * 1000;
      logger.verbose(`Waiting ${waitTime}ms before retry...`);

      // Simple sleep implementation
      const start = Date.now();
      while (Date.now() - start < waitTime) {
        // Busy wait
      }
    }
  }

  throw new Error('Unexpected error in executeCommand');
}

/**
 * Load commit metadata saved by pre-commit hook
 */
function loadCommitMetadata(): CommitMetadata | null {
  try {
    if (!fs.existsSync(METADATA_PATH)) {
      logger.verbose('No commit metadata found, skipping post-commit processing');
      return null;
    }

    const metadataContent = fs.readFileSync(METADATA_PATH, 'utf8');
    const metadata: CommitMetadata = JSON.parse(metadataContent);

    logger.verbose('Commit metadata loaded successfully');
    return metadata;
  } catch (error) {
    logger.error(`Failed to load commit metadata: ${error}`);
    return null;
  }
}

/**
 * Clean up metadata file
 */
function cleanupMetadata(): void {
  try {
    if (fs.existsSync(METADATA_PATH)) {
      fs.unlinkSync(METADATA_PATH);
      logger.verbose('Metadata file cleaned up');
    }
  } catch (error) {
    logger.warn(`Failed to cleanup metadata file: ${error}`);
  }
}

/**
 * Check if there are any LLM readme files to commit
 */
function hasLlmReadmeFiles(): boolean {
  try {
    // Check for both untracked and modified files in master-index directory
    const masterIndexPath = path.join(PROJECT_ROOT, 'master-index');

    // First, check if master-index directory exists
    if (!fs.existsSync(masterIndexPath)) {
      logger.verbose('master-index directory does not exist');
      return false;
    }

    // Check if directory is empty
    const entries = fs.readdirSync(masterIndexPath);
    if (entries.length === 0) {
      logger.verbose('master-index directory is empty');
      return false;
    }

    // Check for any LLM readme files in master-index directory recursively
    function findLlmReadmeFiles(dir: string): { files: string[]; stats: { standard: number; enhanced: number } } {
      const files: string[] = [];
      let standardCount = 0;
      let enhancedCount = 0;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const subResult = findLlmReadmeFiles(fullPath);
          files.push(...subResult.files);
          standardCount += subResult.stats.standard;
          enhancedCount += subResult.stats.enhanced;
        } else if (entry.isFile()) {
          if (entry.name.endsWith('.json') &&
            (entry.name.includes('llmreadme') ||
              entry.name === 'project-root.json' ||
              entry.name.includes('-root.json') ||
              (entry.name.match(/^[a-zA-Z0-9\-_]+\.json$/) &&
                !entry.name.startsWith('package') &&
                !entry.name.startsWith('tsconfig') &&
                !entry.name.startsWith('eslint')))) {
            files.push(fullPath);
            standardCount++;
          }
        }
      }
      return { files, stats: { standard: standardCount, enhanced: enhancedCount } };
    }

    const result = findLlmReadmeFiles(masterIndexPath);

    if (result.files.length === 0) {
      logger.verbose('No LLM readme files found in master-index directory');
      return false;
    }

    logger.verbose(`Found ${result.files.length} LLM readme files for commit (all using standard naming convention)`);
    if (result.files.length > 0) {
      logger.info(`📁 LLM readme files found in master-index:`);
      result.files.forEach(file => logger.info(`  - ${path.relative(PROJECT_ROOT, file)}`));
    }
    return true;
  } catch (error) {
    logger.warn(`Failed to check for LLM readme files: ${error}`);
    return false;
  }
}

/**
 * Restore and commit LLM readme files from stash
 */
function commitLlmReadmeFiles(metadata: CommitMetadata): boolean {
  try {
    // Check if there are LLM readme files to commit
    if (!hasLlmReadmeFiles()) {
      logger.info('\u26A0\uFE0F No LLM readme files found to commit');
      return true;
    }

    // Stage all LLM readme files using a robust approach
    logger.highlight(`\uD83D\uDCDD Staging LLM readme files...`);

    // Use git add with specific paths to avoid command length issues
    const masterIndexPath = path.join(PROJECT_ROOT, 'master-index');

    try {
      // Use git add from project root to stage master-index files
      const gitAddCommand = 'git add master-index/';
      executeCommand(gitAddCommand, { retries: 1, timeout: 60000 });

      // Verify staging worked
      const stagedCheck = 'git diff --name-only --cached master-index/';
      const stagedFiles = executeCommand(stagedCheck, { retries: 1 });

      if (!stagedFiles || !stagedFiles.trim()) {
        throw new Error('No files were successfully staged');
      }

      const fileCount = stagedFiles.trim().split('\n').filter(f => f && f.trim()).length;
      logger.success(`\u2705 Successfully staged ${fileCount} LLM readme files`);
    } catch (error) {
      throw error;
    }

    // Generate commit message (no timestamp replacement needed as message is already complete)
    const commitMessage = metadata.commitMessage;

    // Create the commit
    logger.highlight(`\uD83D\uDCDD Creating LLM readme commit...`);
    const commitCommand = `git commit -m "${commitMessage}" --no-verify`;
    executeCommand(commitCommand, { retries: 1, timeout: 60000 });

    logger.success(`\u2705 LLM readme files committed successfully!`);
    logger.info(`\uD83D\uDCDD Commit message: "${commitMessage}"`);
    return true;
  } catch (error) {
    logger.error(`\u274C Failed to commit LLM readme files: ${error}`);
    return false;
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    logger.highlight(`🚀 STARTING POST-COMMIT LLM README PROCESSING`);

    // Load metadata from pre-commit hook
    const metadata = loadCommitMetadata();
    if (!metadata) {
      logger.info('No LLM readme processing needed');
      return;
    }

    if (!metadata.hasLlmReadmeFiles) {
      logger.info('No LLM readme files flagged for processing');
      return;
    }

    // Commit LLM readme files
    const success = commitLlmReadmeFiles(metadata);

    const duration = Date.now() - startTime;

    if (success) {
      logger.highlight(`✅ POST-COMMIT PROCESSING COMPLETED SUCCESSFULLY IN ${duration}MS`);
      logger.success('🎉 TWO-COMMIT FLOW COMPLETED:');
      logger.info('   1️⃣ First commit: User changes with original message');
      logger.info('   2️⃣ Second commit: LLM readme files in master-index');
      logger.info('🤖 Generated master index with deduplicode.ai');
    } else {
      logger.warn(`⚠️ Post-commit processing completed with warnings in ${duration}ms`);
      logger.info('💡 You may need to manually commit files in master-index/');
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error(`❌ Post-commit processing failed after ${duration}ms: ${error.message}`);
    logger.info('💡 Check for uncommitted files in master-index/ directory');
    // Continue execution - don't exit with error code
  } finally {
    // Always cleanup metadata file
    cleanupMetadata();
  }
}

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, cleaning up...');
  cleanupMetadata();
  process.exit(0); // Changed from 1 to 0 to not block commit process
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, cleaning up...');
  cleanupMetadata();
  process.exit(0); // Changed from 1 to 0 to not block commit process
});

// Run the script
main().catch((error) => {
  logger.error(`Unhandled error: ${error}`);
  cleanupMetadata();
  process.exit(0); // Changed from 1 to 0 to not block commit process
}); 