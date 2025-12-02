#!/usr/bin/env ts-node

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';


/**
 * Pre-commit script for generating and organizing LLM readme files
 * This script runs the LLM readme generator and moves all generated llmreadme.json files
 * to the master-index folder maintaining the same directory structure
 * 
 * Enhanced version: Creates two separate commits - one for regular files and one for LLM readme files
 */

const PROJECT_ROOT = process.cwd();
const MASTER_INDEX_DIR = path.join(PROJECT_ROOT, 'master-index');
const LLM_GENERATOR_PATH = path.join(PROJECT_ROOT, 'apps', 'backend', 'bin', 'llm-readme-generator', 'llm-readme-generator-win-x64.exe');
const DOCKER_IMAGE = 'llm-readme-generator:latest';

interface ScriptConfig {
  timeout: number; // milliseconds
  maxRetries: number;
  logLevel: 'info' | 'verbose' | 'silent';
  createSeparateCommits: boolean; // Whether to prepare for separate commits
  readmeCommitMessage: string; // Template for the readme commit message
  useDocker: boolean; // Whether to use Docker for generation
  targetDirectories: string[]; // Directories to analyze (empty for root)
}

const config: ScriptConfig = {
  timeout: 300000, // 5 minutes
  maxRetries: 3,
  logLevel: 'verbose', // Changed to verbose for better debugging
  createSeparateCommits: true, // CHANGED: Use separate commits for clean flow
  readmeCommitMessage: "🤖 Generated master index with deduplicode.ai - Enhanced project documentation and analysis",
  useDocker: false, // Will be auto-detected
  targetDirectories: [] // Empty means use root directory
};

/**
 * Logger utility
 */
class Logger {
  private level: string;

  constructor(level: string = 'info') {
    this.level = level;
  }

  info(message: string, ...args: any[]) {
    if (this.level !== 'silent') {
      console.log(`[INFO] ${message}`, ...args);
    }
  }

  verbose(message: string, ...args: any[]) {
    if (this.level === 'verbose') {
      console.log(`[VERBOSE] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]) {
    console.error(`[ERROR] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]) {
    console.warn(`[WARN] ${message}`, ...args);
  }

  success(message: string, ...args: any[]) {
    console.log(`[SUCCESS] ${message}`, ...args);
  }

  highlight(message: string, ...args: any[]) {
    console.log(`>> ${message.toUpperCase()}`, ...args);
  }
}

const logger = new Logger(config.logLevel);

/**
 * Ensure directory exists, create if it doesn't
 */
function ensureDirectoryExists(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.verbose(`Created directory: ${dirPath}`);
    }
  } catch (error) {
    throw new Error(`Failed to create directory ${dirPath}: ${error}`);
  }
}

/**
 * Move file from source to destination
 */
function moveFile(source: string, destination: string): void {
  try {
    // Ensure destination directory exists
    const destDir = path.dirname(destination);
    ensureDirectoryExists(destDir);

    // Move file (overwrite if exists)
    if (fs.existsSync(destination)) {
      fs.unlinkSync(destination); // Remove existing file first
    }
    fs.renameSync(source, destination);
    logger.verbose(`Moved: ${source} -> ${destination}`);
  } catch (error) {
    throw new Error(`Failed to move file from ${source} to ${destination}: ${error}`);
  }
}

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
        stdio: 'pipe' // Always use pipe to capture output, regardless of log level
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
 * Recursively find all LLM readme files (both llmreadme.json and llmreadme-enhanced.json) in the project
 */
async function findLlmReadmeFiles(): Promise<string[]> {
  try {
    logger.verbose('Searching for LLM readme files (llmreadme.json and llmreadme-enhanced.json)...');

    const files: string[] = [];
    const ignoredDirs = ['node_modules', '.git', 'master-index', 'dist', 'build'];
    const readmeFileNames = ['llmreadme.json', 'llmreadme-enhanced.json'];

    function walkDirectory(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(PROJECT_ROOT, fullPath);

        if (entry.isDirectory()) {
          // Skip ignored directories
          if (ignoredDirs.includes(entry.name)) {
            continue;
          }

          // Skip nested ignored directories
          if (ignoredDirs.some(ignored => relativePath.includes(ignored))) {
            continue;
          }

          walkDirectory(fullPath);
        } else if (entry.isFile() && readmeFileNames.includes(entry.name)) {
          files.push(relativePath);
        }
      }
    }

    walkDirectory(PROJECT_ROOT);

    const jsonCount = files.filter(f => f.endsWith('llmreadme.json')).length;
    const enhancedCount = files.filter(f => f.endsWith('llmreadme-enhanced.json')).length;

    logger.verbose(`Found ${files.length} LLM readme files (${jsonCount} standard, ${enhancedCount} enhanced)`);
    if (files.length > 0) {
      logger.info(`📁 LLM readme files found:`);
      files.forEach(file => logger.info(`  - ${file}`));
    }
    return files;
  } catch (error) {
    throw new Error(`Failed to find LLM readme files: ${error}`);
  }
}

/**
 * Get relative path from project root
 */
function getRelativePath(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath);
}

/**
 * Process and move all llmreadme.json files to master-index
 */
async function processLlmReadmeFiles(): Promise<void> {
  try {
    logger.highlight('\uD83D\uDD0D Searching for LLM readme files in project...');
    const llmReadmeFiles = await findLlmReadmeFiles();

    if (llmReadmeFiles.length === 0) {
      logger.warn('\u26A0\uFE0F No LLM readme files found');
      logger.info('💡 Make sure the LLM generator has created llmreadme.json or llmreadme-enhanced.json files');
      return;
    }

    logger.info(`\uD83D\uDCCA Found ${llmReadmeFiles.length} LLM readme files to process`);

    ensureDirectoryExists(MASTER_INDEX_DIR);
    let filesFound = 0;
    let filesCopied = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    const excludeDirs = ['benchmark', 'benchmarks', 'node_modules', '.git', 'dist', 'coverage'];

    function transformPathToFilename(filePath: string): string {
      // Get directory path and original filename
      let dirPath = path.dirname(filePath);
      const originalFilename = path.basename(filePath);

      // FIXED: Always use normal naming convention, regardless of input file type
      logger.verbose(`Transforming ${originalFilename} from ${dirPath}`);

      // Handle project root
      if (dirPath === '.' || dirPath === '') {
        return 'project-root.json'; // Always normal naming
      }

      // Remove leading ./ if present
      dirPath = dirPath.replace(/^[.\\/]+/, '');

      // Replace / and \ with -
      let normalized = dirPath.replace(/[\\/]+/g, '-');

      // Add -root suffix for main directories (matching bash script logic)
      if (/^(src|test|docs|tools|types)$/.test(normalized)) {
        return `${normalized}-root.json`; // Always normal naming
      }

      return `${normalized}.json`; // Always normal naming
    }

    // SIMPLIFIED: Process ALL found LLM readme files (no complex filtering)
    logger.info('📝 Processing ALL found LLM readme files...');

    for (const relativeFilePath of llmReadmeFiles) {

      // Exclude unwanted dirs
      if (excludeDirs.some(dir => relativeFilePath.includes(dir))) {
        logger.info(`\u23ED\uFE0F  SKIP ${relativeFilePath} (excluded)`);
        filesSkipped++;
        continue;
      }

      filesFound++;
      const sourceFile = path.join(PROJECT_ROOT, relativeFilePath);
      const targetFilename = transformPathToFilename(relativeFilePath);
      const destFile = path.join(MASTER_INDEX_DIR, targetFilename);
      let action = '';

      if (fs.existsSync(destFile)) {
        action = '\uD83D\uDCDD UPDATE';
        filesUpdated++;
      } else {
        action = '\uD83D\uDCC4 NEW';
        filesCopied++;
      }

      // Move file (remove from source) - ensure destination directory exists
      try {
        // Ensure destination directory exists
        const destDir = path.dirname(destFile);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        // Check if source file actually exists
        if (!fs.existsSync(sourceFile)) {
          logger.warn(`⚠️ Source file does not exist: ${sourceFile}`);
          filesSkipped++;
          continue;
        }

        logger.info(`🔄 Moving: ${sourceFile} → ${destFile}`);

        // Move file (rename first, fallback to copy+delete)
        fs.renameSync(sourceFile, destFile);
        logger.info(`  ${action} (moved) ${relativeFilePath} \u2192 ${targetFilename}`);
      } catch (err) {
        // Fallback to copy+unlink if rename fails (e.g. cross-device)
        try {
          fs.copyFileSync(sourceFile, destFile);
          fs.unlinkSync(sourceFile);
          logger.info(`  ${action} (copied+deleted) ${relativeFilePath} \u2192 ${targetFilename}`);
        } catch (fallbackErr) {
          logger.error(`Failed to move ${relativeFilePath}: ${fallbackErr}`);
          filesSkipped++;
        }
      }
    }

    logger.success(`\u2705 Collection Complete!`);
    logger.info(`\uD83D\uDCCA Files found: ${filesFound}`);
    logger.info(`\uD83D\uDCC4 New files: ${filesCopied}`);
    logger.info(`\uD83D\uDCDD Updated files: ${filesUpdated}`);
    logger.info(`\u23ED\uFE0F  Skipped files: ${filesSkipped}`);
    logger.info(`\uD83D\uDCC1 Target directory: master-index/`);
  } catch (error) {
    throw new Error(`Failed to process llmreadme.json files: ${error}`);
  }
}

/**
 * Determine target directories based on staged files
 */
function determineTargetDirectories(): string[] {
  // If target directories are explicitly configured, use them
  if (config.targetDirectories.length > 0) {
    logger.highlight(`USING CONFIGURED TARGET DIRECTORIES: ${config.targetDirectories.join(', ')}`);
    return config.targetDirectories;
  }

  // Check if master-index folder is missing or empty - if so, run full scan
  const masterIndexPath = path.join(PROJECT_ROOT, 'master-index');
  if (!fs.existsSync(masterIndexPath) || isDirectoryEmpty(masterIndexPath)) {
    logger.highlight(`MASTER-INDEX FOLDER MISSING OR EMPTY - RUNNING FULL SCAN`);
    return ['.'];
  }

  try {
    const stagedFiles = getStagedFiles();

    if (stagedFiles.length === 0) {
      logger.highlight(`NO STAGED FILES FOUND - USING ROOT DIRECTORY FOR ANALYSIS`);
      return ['.'];
    }

    logger.info(`Found ${stagedFiles.length} staged files, analyzing for target directories...`);

    // Extract exact file paths and their immediate parent directories
    const targetPaths = new Set<string>();
    const changedFiles = new Set<string>();

    for (const file of stagedFiles) {
      changedFiles.add(file);
      // Get the immediate parent directory
      const parentDir = path.dirname(file);
      if (parentDir !== '.') {
        targetPaths.add(parentDir);
      } else {
        // If file is in root, add the file itself
        targetPaths.add(file);
      }
    }

    // Filter out common directories that shouldn't be analyzed
    const excludedDirs = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt'];
    const filteredPaths = Array.from(targetPaths).filter(dir =>
      !excludedDirs.includes(dir) &&
      !excludedDirs.some(excluded => dir.startsWith(excluded + '/'))
    );

    if (filteredPaths.length > 0) {
      logger.highlight(`TARGET PATHS BASED ON STAGED CHANGES: ${filteredPaths.join(', ')}`);
      logger.info(`Changed files: ${Array.from(changedFiles).join(', ')}`);
      return filteredPaths;
    }

    // If no valid paths found, use root
    logger.highlight(`NO VALID TARGET PATHS FOUND - USING ROOT DIRECTORY`);
    return ['.'];
  } catch (error) {
    logger.warn(`Failed to determine target directories: ${error}`);
    logger.highlight(`FALLING BACK TO ROOT DIRECTORY`);
    return ['.'];
  }
}

/**
 * Check if a directory is empty (no files or subdirectories)
 */
function isDirectoryEmpty(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath)) {
      return true;
    }

    const entries = fs.readdirSync(dirPath);
    return entries.length === 0;
  } catch (error) {
    logger.warn(`Failed to check if directory is empty: ${error}`);
    return true; // Assume empty if we can't check
  }
}

// Removed unstaging function - no longer needed with stash approach

/**
 * Save commit metadata for post-commit hook
 */
function saveCommitMetadata(): void {
  if (!config.createSeparateCommits) {
    return;
  }

  try {
    logger.verbose('Saving commit metadata for post-commit hook...');

    const metadata = {
      timestamp: new Date().toISOString(),
      commitMessage: config.readmeCommitMessage,
      hasLlmReadmeFiles: true
    };

    const metadataPath = path.join(PROJECT_ROOT, '.git', 'llm-readme-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    logger.verbose('Commit metadata saved successfully');
  } catch (error) {
    logger.warn(`Failed to save commit metadata: ${error}`);
  }
}

/**
 * Stage LLM readme files for the post-commit hook using git stash
 */
async function stageLlmReadmeFiles(): Promise<void> {
  try {
    // Generate timestamp and save metadata for post-commit hook
    saveCommitMetadata();

    if (!config.createSeparateCommits) {
      // Single commit mode: Stage master-index with user changes
      logger.info('🎯 Staging master-index with user changes (single commit mode)...');

      try {
        const masterIndexPath = path.join(PROJECT_ROOT, 'master-index');
        if (fs.existsSync(masterIndexPath) && fs.readdirSync(masterIndexPath).length > 0) {
          const gitAddCommand = 'git add master-index/';
          executeCommand(gitAddCommand, { retries: 1 });
          logger.success('✅ master-index staged with user changes');
        }
      } catch (error) {
        logger.error(`❌ Failed to stage master-index: ${error}`);
      }
      return;
    }

    // TWO COMMIT MODE: Keep files ready for post-commit hook
    logger.highlight('🎯 TWO-COMMIT MODE: Preparing for separate commits');
    logger.info('📝 User changes will be committed first with their original message');
    logger.info('📁 LLM readme files are ready in master-index/ for post-commit hook');
    logger.info('💡 Post-commit hook will create separate commit for master-index');

  } catch (error) {
    logger.warn(`⚠️ Failed to prepare LLM readme files: ${error}`);
    logger.info('💡 You may need to manually commit the files in master-index/');
  }
}

/**
 * Validate that the LLM generator executable exists
 */
function validateLlmGenerator(): boolean {
  try {
    // FIRST PRIORITY: Check for Docker
    logger.verbose('Checking for Docker availability...');
    try {
      const dockerCheck = executeCommand('docker --version', { retries: 1, timeout: 5000 });
      if (dockerCheck && dockerCheck.trim()) {
        logger.verbose(`Docker found: ${dockerCheck.trim()}`);

        // Check if the image exists
        try {
          executeCommand(`docker image inspect ${DOCKER_IMAGE}`, { retries: 1, timeout: 5000 });
          logger.highlight(`🐳 USING DOCKER FOR README GENERATION`);
          logger.info(`Docker image ${DOCKER_IMAGE} found and ready`);
          config.useDocker = true;
          return true;
        } catch (imageError) {
          logger.warn(`Docker image ${DOCKER_IMAGE} not found: ${imageError}`);
        }
      } else {
        logger.warn('Docker command returned empty response');
      }
    } catch (dockerError) {
      logger.warn(`Docker not available: ${dockerError}`);
    }

    // 2 SECOND PRIORITY: Check for local executable
    logger.verbose(`Checking for local LLM generator at: ${LLM_GENERATOR_PATH}`);
    if (fs.existsSync(LLM_GENERATOR_PATH)) {
      logger.highlight(`🔧 USING LOCAL EXECUTABLE FOR README GENERATION`);
      logger.info(`LLM generator found at: ${LLM_GENERATOR_PATH}`);
      config.useDocker = false;
      return true;
    }

    logger.warn(`Local LLM generator not found at: ${LLM_GENERATOR_PATH}`);
    return false;
  } catch (error) {
    logger.warn(`Error validating LLM generator: ${error}`);
    return false;
  }
}

/**
 * Get list of currently staged files (excluding master-index directory)
 */
function getStagedFiles(): string[] {
  try {
    logger.verbose('Getting list of staged files...');

    // Get list of staged files
    const command = 'git diff --name-only --cached';
    const output = executeCommand(command, { retries: 1 });

    logger.verbose(`Raw git output: "${output}"`);
    logger.verbose(`Output type: ${typeof output}, length: ${output ? output.length : 'null'}`);

    // Handle case where output might be empty or null
    if (!output || output.trim().length === 0) {
      logger.verbose('No staged files found (output is empty)');
      return [];
    }

    // Filter out files in master-index directory
    const files = output
      .trim()
      .split('\n')
      .filter(file => file && file.trim() && !file.startsWith('master-index/'));

    logger.verbose(`Parsed files: ${JSON.stringify(files)}`);
    logger.verbose(`Found ${files.length} staged files (excluding master-index/)`);
    return files;
  } catch (error) {
    logger.warn(`Failed to get staged files: ${error}`);
    return []; // Return empty array instead of throwing
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    logger.highlight(`🚀 STARTING LLM README GENERATION PRE-COMMIT SCRIPT`);

    // Validate prerequisites
    logger.info('Validating prerequisites...');
    const isValid = validateLlmGenerator();

    if (!isValid) {
      logger.warn('⚠️ LLM readme generator not available (executable not found and Docker not configured)');
      logger.info('Skipping LLM readme generation, proceeding with commit');
      return;
    }

    // Determine target directories based on staged changes
    const targetDirs = determineTargetDirectories();

    // Run LLM readme generator
    logger.highlight(`🔧 RUNNING LLM README GENERATOR`);

    // Determine if we need --recursive flag (only for full scans)
    const isFullScan = targetDirs.length === 1 && targetDirs[0] === '.';
    const recursiveFlag = isFullScan ? ' --recursive' : '';

    if (isFullScan) {
      logger.info('🔍 Full scan detected - adding --recursive flag');
    } else {
      logger.info('🎯 Targeted scan - no --recursive flag needed');
    }

    let command: string;

    if (config.useDocker) {
      // Docker command with properly escaped path for Windows
      let dockerPath = PROJECT_ROOT;

      // Convert Windows path to Docker format
      if (process.platform === 'win32') {
        // For Docker Desktop on Windows, try using the original path first
        // Docker Desktop can often handle Windows paths directly
        dockerPath = PROJECT_ROOT;
        logger.verbose(`Using Windows path for Docker: ${dockerPath}`);
      }

      command = `docker run --rm --name llm-readme-runner -v "${dockerPath}:/app" -w /app ${DOCKER_IMAGE} generate ${targetDirs.map(dir => `"${dir}"`).join(' ')} --target llm --format json --detect-placeholders --placeholder-confidence 20 --placeholder-analysis-level enhanced${recursiveFlag}`;
      logger.info(`🐳 Executing Docker command: ${command}`);
    } else {
      // Local executable command
      command = `"${LLM_GENERATOR_PATH}" generate ${targetDirs.map(dir => `"${dir}"`).join(' ')} --target llm --format json --detect-placeholders --placeholder-confidence 20 --placeholder-analysis-level enhanced${recursiveFlag} --exclude-patterns "apps/"`;
      logger.info(`🔧 Executing local command: ${command}`);
    }

    try {
      const startGenTime = Date.now();
      executeCommand(command);
      const genDuration = Date.now() - startGenTime;
      logger.highlight(`✅ LLM README GENERATION COMPLETED SUCCESSFULLY IN ${genDuration}MS`);
    } catch (genError) {
      logger.warn(`⚠️ LLM readme generation failed: ${genError}`);

      // If Docker failed and we're on Windows, try alternative path formats
      if (config.useDocker && process.platform === 'win32') {
        logger.highlight(`🔄 DOCKER FAILED - TRYING ALTERNATIVE PATH FORMATS`);

        // Try different path formats for Windows Docker
        const pathFormats = [
          PROJECT_ROOT.replace(/\\/g, '/'), // Forward slashes
          PROJECT_ROOT.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/'), // No drive letter
          `/${PROJECT_ROOT.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')}` // Unix style
        ];

        for (let i = 0; i < pathFormats.length; i++) {
          const altPath = pathFormats[i];
          logger.info(`Trying alternative path format ${i + 1}: ${altPath}`);

          try {
            const altCommand = `docker run --rm --name llm-readme-runner -v "${altPath}:/app" -w /app ${DOCKER_IMAGE} generate ${targetDirs.map(dir => `"${dir}"`).join(' ')} --target llm --format json --detect-placeholders --placeholder-confidence 20 --placeholder-analysis-level enhanced${recursiveFlag}`;
            executeCommand(altCommand);
            logger.highlight(`✅ DOCKER SUCCEEDED WITH ALTERNATIVE PATH FORMAT ${i + 1}`);
            break;
          } catch (altError) {
            logger.verbose(`Alternative path format ${i + 1} also failed`);
          }
        }
      }

      // If Docker failed and local executable is available, try that as fallback
      if (config.useDocker && fs.existsSync(LLM_GENERATOR_PATH)) {
        logger.highlight(`🔄 DOCKER FAILED - FALLING BACK TO LOCAL EXECUTABLE`);
        config.useDocker = false;

        const localCommand = `"${LLM_GENERATOR_PATH}" generate ${targetDirs.map(dir => `"${dir}"`).join(' ')} --target llm --format json --detect-placeholders --placeholder-confidence 20 --placeholder-analysis-level enhanced${recursiveFlag} --exclude-patterns "apps/"`;
        logger.info(`🔧 Executing local fallback command: ${localCommand}`);

        try {
          const startLocalTime = Date.now();
          executeCommand(localCommand);
          const localDuration = Date.now() - startLocalTime;
          logger.highlight(`✅ LOCAL LLM README GENERATION COMPLETED SUCCESSFULLY IN ${localDuration}MS`);
        } catch (localError) {
          logger.warn(`⚠️ Local LLM readme generation also failed: ${localError}`);
          logger.info('Skipping LLM readme generation, proceeding with commit');
          return;
        }
      } else {
        logger.info('Skipping LLM readme generation, proceeding with commit');
        return;
      }
    }

    // Process and move generated files
    logger.info('📁 Processing generated files...');

    // Add a small delay to ensure files are fully written
    logger.verbose('Waiting 2 seconds for file system to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    await processLlmReadmeFiles();

    // Stage LLM readme files (or prepare for post-commit handling)
    logger.info(config.createSeparateCommits
      ? '📝 Preparing LLM readme files for separate post-commit...'
      : '📝 Staging LLM readme files with main commit...');

    await stageLlmReadmeFiles();

    const duration = Date.now() - startTime;
    logger.highlight(`✅ PRE-COMMIT SCRIPT COMPLETED SUCCESSFULLY IN ${duration}MS`);

    // Show which tool was used
    if (config.useDocker) {
      logger.highlight(`🐳 README GENERATION COMPLETED USING DOCKER`);
    } else {
      logger.highlight(`🔧 README GENERATION COMPLETED USING LOCAL EXECUTABLE`);
    }

    if (config.createSeparateCommits) {
      logger.highlight('🎯 TWO-COMMIT FLOW READY:');
      logger.info('   ✅ LLM readme files moved to master-index/');
      logger.info('   📝 Your changes will be committed first');
      logger.info('   🤖 Then post-commit hook will create separate master-index commit');
    } else {
      logger.info('📝 All llmreadme.json files have been moved to master-index/ and staged for commit');
    }

  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error(`❌ Pre-commit script failed after ${duration}ms: ${error.message}`);
    logger.info('Proceeding with commit despite errors');
  }
}

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, exiting...');
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, exiting...');
  process.exit(1);
});

// Run the script
main().catch((error) => {
  logger.error(`Unhandled error: ${error}`);
  process.exit(1);
}); 