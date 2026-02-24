---
name: php-optimization-engineer
description: Automatically analyzes and optimizes PHP code by identifying performance bottlenecks, memory issues, and applying fixes directly to files. Creates backups before modifications and provides rollback instructions. Use when user wants to optimize PHP code, improve performance, reduce memory usage, refactor for efficiency, profile code, or investigate deeper into performance issues. Triggers on "optimize PHP", "PHP performance", "slow PHP script", "PHP memory issue", "improve PHP code", "PHP bottleneck", "PHP refactoring", "profile PHP", "PHP profiler", "profile code", "investigate performance", "performance investigation", "debug performance", "analyze performance".
---

# PHP Optimization Engineer

Automatically analyzes PHP codebases to identify performance bottlenecks, memory inefficiencies, and optimization opportunities, then applies optimizations directly to the code files with proper safety measures.

## Prerequisites

Requires `docker`, `docker compose`, and a PHP environment with necessary extensions for analysis and testing. If the PHP version installed locally is not compatible, use the provided Docker setup for a consistent environment. If no Docker environment is available, use a compatible image from Docker Hub to run the analysis and optimizations.

## Scope

This skill **automatically implements optimizations** directly in PHP files. To ensure safety and control:

- Creates backups before any modifications
- Applies optimizations incrementally with testing between changes
- Provides detailed reports of all changes made
- Offers rollback instructions for each modification
- Recommends git commits before applying changes

## Workflow

### Step 1: Initial Code Assessment

1. Identify the PHP files or directories to analyze
2. Determine the scope:
   - Determine the PHP version and framework (if any) in use
   - Identify critical areas (e.g., high-traffic endpoints, known slow scripts)
   - Single file optimization
   - Module/component analysis
   - Full application audit
3. Ask about specific concerns:
   - Performance issues (slow page loads, timeouts)
   - Memory problems (fatal errors, high consumption)
   - Database bottlenecks
   - General code quality improvement

### Step 2: Static Code Analysis

Scan for common optimization opportunities:

**Performance Patterns:**
- Loops inside loops (O(n²) complexity)
- Multiple database connections and/or client instantiations (for example, `new MongoDB\Client` inside a loop)
- Repeated database queries in loops (N+1 problems)
- Unnecessary file and/or logging I/O operations
- Expensive operations inside frequently called functions
- Missing opcache considerations
- Inefficient string concatenation (using `.` in loops instead of arrays + `implode`)
- Unnecessary serialization/deserialization
- Missing early returns in conditional logic
- Unnecessary function calls (e.g., `count()` when `isset()` would suffice)
- Unoptimized regular expressions
- Missing array functions for common operations
- Unnecessary object instantiation (e.g., creating new objects when static methods would suffice)
- Late static binding that could be optimized to avoid overhead
- Unnecessary use of `eval()` or dynamic code execution
- Inefficient use of namespaces and autoloading (e.g., including files that are not used)
- Missing or inefficient use of generators for large datasets
- Unoptimized use of closures and anonymous functions, especially in loops (e.g., creating a new closure inside a loop instead of defining it once)
- Unnecessary use of global variables or superglobals that could be passed as parameters
- Missing or inefficient use of constants instead of variables for configuration values (e.g., using `define('CONFIG_VALUE', 'value')` instead of `$configValue = 'value', or calling `getenv('CONFIG_VALUE')` repeatedly instead of defining a constant)
- Unoptimized use of traits and interfaces (e.g., using traits that add unnecessary methods or properties, or using interfaces that are not implemented by multiple classes)
- Unnecessary use of magic methods (e.g., `__get`, `__set`, `__call`) that can add overhead and reduce readability
- Duplicate function calls with the same arguments that could be cached (e.g., calling `strtotime()` multiple times with the same date string)

**Memory Patterns:**
- Loading large datasets into memory at once (e.g., fetching all rows from a database without pagination or using unbuffered queries)
- Unprocessed array copies
- Memory leaks in long-running scripts (e.g., accumulating data in static variables or global arrays without clearing them)
- Missing `unset()` for large variables
- Inefficient string concatenation that creates multiple copies in memory
- Recursive functions without memory limits
- Extensive use of custom classes and objects that could be optimized with arrays or simpler data structures

**Database Patterns:**
- Missing or inefficient indexes
- SELECT * instead of specific columns
- Missing prepared statements
- Unbuffered queries when buffering would help
- Missing transaction blocks for multiple operations
- N+1 query problems
- Missing JOIN optimization opportunities
- Unnecessary DISTINCT operations
- Missing connection pooling considerations
- Repeatedly fetching the same data in different queries
- Missing query caching opportunities
- Unnecessary sorting when not needed
- Missing LIMIT clauses on queries that could return large result sets

**Caching Patterns:**
- Missing opportunities for caching
- Inefficient cache key strategies
- No cache invalidation strategy
- Repeated expensive computations

### Step 3: Detailed Analysis by Category

#### 3.1 Performance Analysis

Look for:
- `foreach`/`for` loops that could use array functions
- String concatenation in loops (use array + implode)
- Repeated function calls with same result (cache the result)
- Regex operations that could use string functions
- Unnecessary object instantiation
- Late static binding that could be optimized
- (in Laravel) calls to `filled()`, `blank()` and `empty()` that could be optimized by using `isset()` or direct checks

#### 3.2 Memory Analysis

Look for:
- `array_map`/`array_filter` creating copies unnecessarily
- Large result sets fetched all at once
- Recursive functions without memory limits
- Static variables accumulating data
- Missing generators for large datasets

#### 3.3 Database Analysis

Look for:
- Queries without LIMIT clauses
- Missing JOIN optimization
- Subqueries that could be JOINs
- Missing connection pooling considerations
- Unnecessary DISTINCT operations

#### 3.4 Caching Analysis

Look for:
- Expensive calculations without caching
- Database query results not cached
- Configuration data loaded repeatedly
- Template/view compilation opportunities

### Step 4: Apply Optimizations and Report

1. **Pre-Implementation Safety**
   - Document the original state of code to be changed
   - Create a new branch for changes
   - Benchmark current performance/memory usage for comparison
   - Document all changes in a changelog with explanations and expected benefits

2. **Apply Optimizations by Priority**
   - Critical: Performance bottlenecks causing user-visible issues
   - High: Significant resource waste
   - Medium: Notable improvements available
   - Low: Minor optimizations

3. **For Each Optimization Applied:**
   - File and line number
   - Original code snippet
   - Optimized code applied
   - Description of change
   - Expected improvement
   - Backup file location

4. **Post-Implementation Validation**
   - Run existing test suites
   - Suggest runtime validation commands
   - Verify no syntax errors introduced

## Safety Precautions

### Before Modifying Files

1. **Always Create Backups**
   ```bash
   # Automatic branch creation and backup
   git checkout -b optimization-$(date +%Y%m%d-%H%M%S)
   ```

2. **Git Integration (Recommended)**
   ```bash
   # Commit current state before optimizations
   git add -A && git commit -m "Pre-optimization snapshot"
   ```

3. **Verify File Writability**
   - Check file permissions
   - Ensure no lock files exist

### After Modifying Files

1. **Run Tests**
   ```bash
   # PHPUnit
   php vendor/bin/phpunit

   # Laravel
   php artisan test

   # Symfony
   php bin/phpunit
   ```

   Note which tests failed and why, if any. There's a high likelihood that those failures are not due to the optimizations but it's important to verify.

2. **Syntax Validation**
   ```bash
   php -l path/to/file.php
   ```

3. **Provide Rollback Instructions**
   ```bash
   # To rollback all changes via git
   git checkout <previous-branch>
   ```

### Change Documentation

For every file modified, provide:
- Summary of changes made
- Diff showing before/after
- List of affected functions/methods
- Any breaking changes or API modifications

## Optimization Categories

### Performance Optimizations

| Category | Common Issues | Solutions |
|----------|--------------|-----------|
| Loops | Nested iterations, repeated operations | Use array functions, cache results |
| String Operations | Concatenation in loops | Use array + implode, heredoc syntax |
| Function Calls | Repeated expensive calls | Cache results, use memoization |
| File I/O | Multiple file reads | Read once, cache content |
| Object Creation | Unnecessary instantiation | Use static methods, singletons |

### Memory Optimizations

| Category | Common Issues | Solutions |
|----------|--------------|-----------|
| Arrays | Large copies, unnecessary duplication | Use references, generators |
| Database Results | Fetching all rows | Use unbuffered queries, pagination |
| Variables | Large objects in memory | Unset after use, use weak references |
| Strings | Large string operations | Use streams, process in chunks |

### Database Optimizations

| Category | Common Issues | Solutions |
|----------|--------------|-----------|
| Queries | N+1 problems, SELECT * | Use JOINs, specify columns |
| Indexes | Missing or inefficient | Add appropriate indexes |
| Connections | New connection per query | Use connection pooling |
| Transactions | Missing for multiple ops | Wrap in transactions |

### Caching Optimizations

| Category | Common Issues | Solutions |
|----------|--------------|-----------|
| Data | Repeated expensive queries | Implement query caching |
| Computation | Same calculations repeated | Use memoization patterns |
| Views | Templates parsed repeatedly | Compile templates, cache output |

## Output Format

```markdown
# PHP Optimization Report

## Summary
- Files Analyzed: [count]
- Optimizations Applied: [count]
- Critical: [count] | High: [count] | Medium: [count] | Low: [count]
- Branch Created: [branch name]

## Applied Optimizations

### Optimization #1: [Title]
**File:** `path/to/file.php:123`
**Priority:** Critical
**Category:** Performance | Memory | Database | Caching

**Original Code:**
```php
// Previous implementation
```

**Applied Optimization:**
```php
// Optimized implementation
```

**Change Description:**
[What was changed and why]

**Expected Improvement:**
[Quantified or described benefit]

**Validation:**
```bash
# Command to verify the change
php -l path/to/file.php
```

---

## Quick Wins Applied
[List of easy-to-implement optimizations that were applied, if any]

## If nothing helped, consider
- Check if SPX is available within the host environment for deeper profiling. If it's not available, use a Docker image with PHP, install any required extensions for the current project and PHP version and iterate until SPX can be used for profiling and optimization
- Run `php -i | grep spx` to check if SPX is available and properly configured, take note of the SPX version and configuration settings for reference in optimization decisions, especially its data directory location.
- Use SPX to identify bottlenecks and memory issues in the code, then apply targeted optimizations based on SPX's insights. A great example is `SPX_ENABLED=1 SPX_REPORT=full SPX_AUTO_START=1 SPX_BUILTINS=1 SPX_METRICS=wt,ct,it,zm,mor,io,ior,iow php your_script.php` to generate a comprehensive report.
- Run `ls -tr1 /path/to/spx/data/directory/ | tail -n 1` to find the latest SPX report file, then analyze it to identify specific functions or lines of code that are causing performance issues or memory leaks. Use this information to apply targeted optimizations in the PHP codebase.

### Important considerations
- If the waits consist mostly of `wait on file`, `wait on stream`, `wait on socket` or anything related to `it` (idle time), it may indicate that the script is waiting for external resources, such as file I/O, network requests, or database queries. In this case, consider optimizing those interactions by reducing the number of calls, using asynchronous processing, or implementing caching strategies to minimize wait times. Ultimately, if nothing helps, ask the user to investigate the infrastructure associated to those external resources, as the bottleneck may be outside of the PHP code itself.
- If the waits consist mostly of I/O operations (`io`, `ior`, `iow`), it may indicate that the script is performing a lot of input/output operations, such as reading/writing files or making network requests. In this case, consider optimizing those interactions by reducing the number of calls, using asynchronous processing, or implementing caching strategies to minimize I/O operations. If the I/O operations are related to database interactions, consider optimizing the database queries or connection handling to reduce the number of I/O operations required.

### Edge cases
The PHP compiler is generally very good at optimizing code, however, there may be edge cases where the optimizations applied by this skill can't cover these known edge cases. In those cases, use context clues and do a deeper research of the code, then, check if any of these specific optimizations can be applied to the codebase:

- Instead of checking `if (count($array) > 0)`, use `if (!empty($array))` or `if (isset($array[0]))` to avoid counting the entire array.
- Instead of using `foreach` to filter an array, use `array_filter()` for better performance.
- Instead of concatenating strings in a loop, use an array to collect the parts and then use `implode()` to concatenate them all at once.
- Instead of using `strtotime()` multiple times with the same date string, call it once and store the result in a variable for reuse.
- Instead of using `is_array()` to check if a variable is an array, use `(array) $variable === $variable` to avoid the overhead of a function call, trying to cast the variable to an array and comparing it to the original variable, this can be faster than calling `is_array()`.
- Check the profiler results for important DEBUG logging calls that may be left in the code, these calls can be very expensive even if the log level is set to INFO or higher, as the message construction and context gathering can still occur. If such calls are found, consider removing them or creating a custom logging class that exits early if the log level is above DEBUG to avoid the overhead of these calls in production code.
- Instead of using `file_get_contents()` to read a file, use `fopen()` and `fread()` for better performance, especially for large files, as it allows you to read the file in chunks instead of loading the entire file into memory at once.
- Instead of using `json_encode()` and `json_decode()` to process JSON data, consider using a streaming JSON parser if the data is large, as it can process the data in chunks and reduce memory usage. If on PHP 8.0 or higher, consider using `awesomized/simdjson-plus-php-ext` (downloadable from GitHub) for significantly faster JSON processing, especially for large datasets, as it leverages SIMD instructions for parsing.
- If the user needs to use `Carbon`, attempt to minimize the number of `Carbon` instances created, as they can be memory-intensive. Consider using native PHP date functions or a lightweight date library if only basic date manipulation is needed, or if the code creates many `Carbon` instances in a loop, try to refactor it to create fewer instances by reusing them or by using static methods when possible.

## When all else fails
- Debug the database operations and external API calls to identify if the bottleneck is outside of the PHP code. If the bottleneck is in the database, consider optimizing the queries, adding indexes, or using a caching layer. If the bottleneck is in external API calls, consider implementing caching strategies, reducing the number of calls, or using asynchronous processing to minimize wait times.
- Ask the user to provide an example call to the script that is experiencing performance issues and how they are running it (e.g., via CLI, web server, etc.) and where (a real VM, Docker, Kubernetes, etc.). If the user responds that they're relying on Kubernetes, ask them to provide a `kubeconfig` file or the necessary credentials to access the cluster, then, use `kubectl` to access the logs of the relevant pods and check for any errors or performance issues that may be occurring. Check if the size of the capacity of the infrastructure is sufficient for the workload, and if there are any resource limits being hit that could be causing performance degradation. Use `get events` to check for any events related to the pods that may indicate issues with scheduling, resource allocation, or other problems that could be affecting performance.
- Offer the user to launch a server with the necessary environment to run the SPX's web UI, then, guide them through the process of accessing the SPX web UI and analyzing the profiling results to identify specific functions or lines of code that are causing performance issues or memory leaks. Use this information to apply targeted optimizations in the PHP codebase.

## Recommendations for Manual Review
1. [Items that require human decision-making]
2. [Complex optimizations that need testing in staging]
3. [Changes that may affect business logic]
```

## Profiling with SPX

**CRITICAL: When the user requests profiling or performance investigation, you MUST use SPX (Simple Profiling eXtension) as the profiler. Do NOT use Xdebug, Blackfire, Tideways, or any other profiler unless SPX is genuinely unavailable and all attempts to install it have failed.**

SPX is the required profiler for this skill because:
- Minimal performance overhead compared to other profilers
- Built-in web UI for analyzing results
- Detailed metrics including wall time, CPU time, idle time, memory, and I/O
- No external service dependencies

### SPX Profiling Workflow

1. **Check SPX Availability**
   ```bash
   php -i | grep spx
   ```
   If SPX is available, note the version and configuration, especially the data directory location.

2. **If SPX is Not Available**
   - Use a Docker image with PHP and SPX pre-installed
   - Or install SPX extension for the current PHP version
   - Iterate until SPX is working before proceeding with profiling

3. **Run SPX Profiler**
   ```bash
   # CLI profiling with comprehensive metrics
   SPX_ENABLED=1 SPX_REPORT=full SPX_AUTO_START=1 SPX_BUILTINS=1 SPX_METRICS=wt,ct,it,zm,mor,io,ior,iow php your_script.php
   
   # Web request profiling (add to URL or header)
   # Add SPX_ENABLED=1&SPX_REPORT=full to query string
   # Or add X-SPX-Enabled: 1 header
   ```

4. **Analyze SPX Results**
   ```bash
   # Find the latest SPX report
   ls -tr1 /path/to/spx/data/directory/ | tail -n 1
   
   # Open the web UI (if available)
   # Navigate to /spx.php in your application
   ```

5. **Interpret SPX Metrics**
   - `wt` - Wall Time: Total elapsed time
   - `ct` - CPU Time: Time spent executing code
   - `it` - Idle Time: Time waiting for I/O or external resources
   - `zm` - Zend Memory: Memory allocated by PHP
   - `mor` - Memory Own Retained: Memory retained by functions
   - `io`, `ior`, `iow` - I/O operations (read/write)

### When SPX Results Show Specific Patterns

- **High `it` (Idle Time)**: Script is waiting for external resources (file I/O, network, database). Optimize those interactions or investigate infrastructure.
- **High I/O metrics**: Many file/network operations. Consider caching, batching, or async processing.
- **High memory metrics**: Memory leaks or inefficient data structures. Look for large arrays, missing unset(), or generators opportunities.

## Tips

- **Start with Critical issues:** Focus on user-visible performance problems first
- **Measure before and after:** Use SPX profiler for accurate performance measurements
- **One change at a time:** Apply optimizations incrementally to measure impact
- **Consider trade-offs:** Some optimizations reduce readability; document why changes were made
- **Test thoroughly:** Performance optimizations can introduce bugs; always test after changes
- **Profile in production-like environment:** Development environments may not show real bottlenecks
- **Keep backups until verified:** Don't delete backup files until changes are confirmed working

## Common Tools for Validation

In Laravel, look for any calls to `dd()` or `dump()` that should be removed in production code. In Symfony, check for any `dump()` calls that may have been left in. In general, look for any debugging statements that may have been left in the code and remove them as part of the optimization process, these calls are generally leaking memory and should be removed in production code.

## Limitations

- Analysis is based on static code review; runtime profiling provides additional insights
- Cannot detect all issues without actual execution data
- Optimizations may need adaptation for specific frameworks (Laravel, Symfony, etc.)
- Database optimizations may require DBA input for index strategies
- Some optimizations may not be automatically applicable and will be flagged for manual review
