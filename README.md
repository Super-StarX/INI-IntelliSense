[Read this in Chinese (简体中文)](./README.zh-cn.md)

# INI IntelliSense for Red Alert 2

**INI IntelliSense** is a powerful, feature-rich Visual Studio Code extension tailor-made for *Command & Conquer: Red Alert 2* mod development. It aims to revolutionize your workflow on `.ini` configuration files by providing a modern coding experience, including dynamic syntax highlighting, deep language intelligence, advanced diagnostics, and intuitive inheritance visualization.

---

## Key Features

### 1. Dynamic Syntax Highlighting
Going beyond traditional static syntax files, this extension provides more accurate and richer coloring through dynamic code analysis.
- **Multi-level Keys**: Applies different colors to different parts of `Key.Part1.Part2`.
- **Complex Section Syntax**: Accurately highlights the `[Section]:[Inherits]` structure.
- **Fully Customizable**: All colors can be freely configured in VS Code settings.

### 2. Schema-Driven IntelliSense
The core capabilities of this extension are driven by a configurable rule file (`INICodingCheck.ini`), providing unparalleled contextual awareness.
- **Auto-Completion**:
    - **Keys**: Intelligently suggests all available keys based on the current section's type (including inheritance).
    - **Values**: Provides completion for boolean values (`yes`/`no`), colors, and all IDs registered in `[Registries]` (e.g., unit, building, weapon names).
- **Hover Information**:
    - **Type Hints**: Hovering over a key displays its type as defined in the schema (e.g., `TechLevel: int`).
    - **Override Details**: When a key overrides a value from a parent section, the hover information clearly shows the **overridden parent section's name, file, line number, and the old value**, with a one-click link to jump to it.
- **Go to Definition**:
    - Hold `Ctrl` and click on a value (like a unit ID) to jump across files to that unit's `[Section]` definition.

### 3. Advanced Diagnostics
- **Built-in Real-time Checks**:
    - **Code Style**: Checks for extra spaces around the equals sign, leading whitespace; ensures proper spacing before/after comments.
    - **Type Validation**: Validates value types in real-time against the schema (e.g., `int`, `float`, numeric ranges, enum values).
- **External Validator Integration**:
    - Seamlessly integrates with `INIValidator.exe` for deeper, cross-file logical validation. Easily manage and run it via a status bar icon or command.

### 4. Inheritance & Reference Visualization
- **Override Indicator**: Displays a clear up-arrow (↑) next to the line number, intuitively showing that the key on this line overrides a definition from a parent class.
- **CodeLens**: Above each `[Section]`, it shows how many times that section is referenced as a "value" and "inherited from" across the entire workspace.
- **Find All References**: Right-click a section name to find all places that reference or inherit from it.

### 5. More Handy Features
- **Color Picker**: Provides a visual color picker and preview for `R,G,B` formatted color values.
- **INI Project Explorer**: A dedicated view in the activity bar that clearly displays all indexed INI files and their internal structure (sections, keys) in a tree, for quick navigation.
- **Code Folding**: Supports folding code blocks by `[Section]`, allowing you to focus on the current task.
- **Performance Optimized**: With configurable file indexing rules, the extension only scans the `*.ini` files you specify (by default, only core game files in the root), ensuring swift response even in large workspaces.

---

## Installation & Configuration

### Installation
1. Download the latest `.vsix` file from the release page.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
3. Click the three-dots menu (`...`) in the top-right corner and select "**Install from VSIX...**".
4. Choose the `.vsix` file you downloaded and install it.
5. Reload VS Code.

### Initial Setup
To get full IntelliSense and diagnostics, you need to tell the extension where your schema file (`INICodingCheck.ini`) is located.
1. Click the `$(warning) INI Schema` icon in the VS Code status bar (bottom-right).
2. In the file dialog that appears, find and select your `INICodingCheck.ini` file.
3. The extension will automatically load and index the file. Upon success, the status bar icon will change to `$(check) INI Schema`.

---

## Settings
You can configure this extension in detail in your VS Code `settings.json` file (`Ctrl+,`).

| Setting | Description | Default |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | Absolute path to the INI rule definition file (`INICodingCheck.ini`). This is the core of the IntelliSense. | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | Root directory for `INIValidator.exe` and file indexing (usually your Mod's root directory). | `null` |
| | |
| `ra2-ini-intellisense.indexing.includePatterns` | An array of Glob patterns specifying which INI files to index. Defaults to core game files in the root. | `["rules*.ini", "art*.ini", ...]` |
| `ra2-ini-intellisense.indexing.excludePatterns` | An array of Glob patterns to exclude files from the included set. | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | Enables the inheritance override indicator (arrow icon next to the line number). | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | Shows CodeLens (reference counts) above sections. | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | Enables all built-in diagnostic checks. | `true` |
| `ra2-ini-intellisense.diagnostics.disable` | An array of error codes to disable specific checks, e.g., `["STYLE-101"]`. | `[]` |
| `ra2-ini-intellisense.diagnostics.leadingWhitespace` | Checks for extraneous whitespace at the beginning of a line. | `true` |
| `ra2-ini-intellisense.diagnostics.spaceBeforeEquals` | Checks for extraneous whitespace to the left of `=`. | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterEquals` | Checks for extraneous whitespace to the right of `=`. | `true` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | The number of spaces required before a `;` comment symbol. Set to `null` to disable. | `1` |
| `ra2-ini-intellisense.diagnostics.spaceAfterComment` | Checks for a missing space after the `;` symbol. | `true` |
| | |
| `ra2-ini-intellisense.exePath` | Absolute path to `INIValidator.exe`. | `null` |
| `ra2-ini-intellisense.validationFiles` | List of files for `INIValidator.exe` to check. | `{...}` |
| | |
| `ra2-ini-intellisense.colors.*` | A series of color settings to customize dynamic syntax highlighting. | ... |

---

## 📄 License
This project is licensed under the MIT License. See the `LICENSE` file for details.