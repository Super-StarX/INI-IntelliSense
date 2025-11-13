# INI IntelliSense for Red Alert 2

**INI IntelliSense** 是一个为《命令与征服: 红色警戒2》Mod开发量身打造的、功能强大的 Visual Studio Code 扩展。它旨在通过提供现代化的代码编辑体验，如动态语法高亮、深度智能感知、高级诊断和直观的继承关系可视化，来革命性地提升您在 `.ini` 配置文件上的工作效率和代码质量。

**INI IntelliSense** is a powerful, feature-rich Visual Studio Code extension tailor-made for *Command & Conquer: Red Alert 2* mod development. It aims to revolutionize your workflow on `.ini` configuration files by providing a modern coding experience, including dynamic syntax highlighting, deep language intelligence, advanced diagnostics, and intuitive inheritance visualization.

---

## 主要功能 (Key Features)

### 1. 动态语法高亮 (Dynamic Syntax Highlighting)
超越传统静态语法文件，本扩展通过代码动态分析，提供更精确、更丰富的着色效果。
- **支持多级键**: 为 `Key.Part1.Part2` 的不同部分应用不同颜色。
- **复杂节语法**: 精确高亮 `[Section]:[Inherits]` 结构。
- **完全可定制**: 所有颜色均可在 VS Code 设置中自由配置。

### 2. Schema 驱动的智能感知 (Schema-Driven IntelliSense)
本扩展的核心能力由一个可配置的规则文件 (`INICodingCheck.ini`) 驱动，提供无与伦比的上下文感知能力。
- **代码自动补全 (Auto-Completion)**:
    - **键 (Keys)**: 根据当前节的类型（包含继承），智能提示所有可用的键。
    - **值 (Values)**: 为布尔值 (`yes`/`no`)、颜色、以及所有在 `[Registries]` 中注册的ID（如单位、建筑、武器名等）提供补全。
- **悬停信息 (Hover Information)**:
    - **类型提示**: 悬停在键上时，显示其在 Schema 中定义的类型 (e.g., `TechLevel: int`)。
    - **继承覆盖详情**: 当一个键覆盖了父节的值时，悬停信息会明确展示**被覆盖的父节名称、所在文件、行号以及旧的值**，并提供一键跳转链接。
- **跳转到定义 (Go to Definition)**:
    - 按住 `Ctrl` 并单击一个值（如单位ID），即可跨文件跳转到该单位的 `[Section]` 定义处。

### 3. 高级诊断与校验 (Advanced Diagnostics)
- **内置实时检查**:
    - **代码风格**: 检查等号周围、行首的多余空格；检查注释前后的空格是否规范。
    - **类型校验**: 根据 Schema 实时验证值的类型是否正确（如 `int`, `float`, 数值范围, 枚举值等）。
- **外部校验器集成**:
    - 与 `INIValidator.exe` 无缝集成，提供更深层次的、跨文件的逻辑有效性检查。可通过状态栏图标或命令轻松管理和运行。

### 4. 继承与引用可视化 (Inheritance & Reference Visualization)
- **继承覆盖指示器**: 在行号旁显示一个清晰的向上箭头 (↑)，直观地告诉您这一行的键覆盖了父类中的定义。
- **代码透镜 (CodeLens)**: 在每个节 `[Section]` 的上方，显示该节在整个工作区中被作为“值”引用的次数和被“继承”的次数。
- **查找所有引用 (Find All References)**: 右键点击一个节名，即可找到所有引用或继承它的地方。

### 5. 其他实用功能 (More Handy Features)
- **颜色拾取器**: 为 `R,G,B` 格式的颜色值提供可视化颜色选择器和预览。
- **INI 项目浏览器**: 在活动栏提供一个专属视图，以树状结构清晰地展示您工作区内所有被索引的 INI 文件及其内部结构（节、键），方便快速导航。
- **代码折叠**: 支持按 `[Section]` 折叠代码块，让您能更专注于当前任务。
- **性能优化**: 通过可配置的文件索引规则，插件只会扫描您指定的 `*.ini` 文件（默认只扫描根目录下的核心游戏文件），在大型工作区中也能保持极速响应。

---

## 安装与配置 (Installation & Configuration)

### 安装 (Installation)
1. 从发布页面下载最新的 `.vsix` 文件。
2. 在 VS Code 中，打开扩展面板 (`Ctrl+Shift+X`)。
3. 点击右上角的三点菜单 (`...`)，选择 “**从 VSIX 安装...**” (Install from VSIX...)。
4. 选择您下载的 `.vsix` 文件并安装。
5. 重新加载 VS Code。

### 初始配置 (Initial Setup)
为了获得完整的智能提示和诊断功能，您需要告诉插件您的 Schema 文件 (`INICodingCheck.ini`) 在哪里。
1. 点击 VS Code 右下角状态栏的 `$(warning) INI Schema` 图标。
2. 在弹出的文件选择框中，找到并选择您的 `INICodingCheck.ini` 文件。
3. 插件会自动加载并索引文件。成功后，状态栏图标会变为 `$(check) INI Schema`。

---

## 详细配置项 (Settings)
您可以在 VS Code 的 `settings.json` 文件中对本插件进行详细配置 (`Ctrl+,`)。

| 设置 (Setting) | 描述 (Description) | 默认值 (Default) |
| :--- | :--- | :--- |
| **`ra2-ini-intellisense.schemaFilePath`** | INI 规则定义文件 (`INICodingCheck.ini`) 的绝对路径。这是智能感知的核心。 | `null` |
| **`ra2-ini-intellisense.validationFolderPath`** | `INIValidator.exe` 和文件索引的根目录（通常是您的Mod根目录）。 | `null` |
| | |
| `ra2-ini-intellisense.indexing.includePatterns` | 一个Glob模式数组，指定需要索引的INI文件。默认只索引根目录的核心文件。 | `["rules*.ini", "art*.ini", ...]` |
| `ra2-ini-intellisense.indexing.excludePatterns` | 一个Glob模式数组，用于从已包含的文件中排除特定文件或目录。 | `[]` |
| | |
| `ra2-ini-intellisense.decorations.overrideIndicator.enabled` | 是否启用继承覆盖指示器（行号旁的箭头图标）。 | `true` |
| `ra2-ini-intellisense.codeLens.enabled` | 是否在节上方显示代码透镜（引用计数）。 | `true` |
| | |
| `ra2-ini-intellisense.diagnostics.enabled` | 是否启用所有内置的诊断检查。 | `true` |
| `ra2-ini-intellisense.diagnostics.disable` | 一个错误码数组，用于禁用特定的诊断检查。例如 `["STYLE-101"]`。 | `[]` |
| `ra2-ini-intellisense.diagnostics.leadingWhitespace` | 是否检查行首多余空格。 | `true` |
| `ra2-ini-intellisense.diagnostics.spaceBeforeEquals` | 是否检查 `=` 左侧的多余空格。 | `true` |
| `ra2-ini-intellisense.diagnostics.spaceAfterEquals` | 是否检查 `=` 右侧的多余空格。 | `true` |
| `ra2-ini-intellisense.diagnostics.spacesBeforeComment` | 注释符号 `;` 前应有的空格数。设为 `null` 可禁用。 | `1` |
| `ra2-ini-intellisense.diagnostics.spaceAfterComment` | 是否检查 `;` 后缺少空格。 | `true` |
| | |
| `ra2-ini-intellisense.exePath` | `INIValidator.exe` 的绝对路径。 | `null` |
| `ra2-ini-intellisense.validationFiles` | `INIValidator.exe` 需要校验的文件列表。 | `{...}` |
| | |
| `ra2-ini-intellisense.colors.*` | 用于自定义动态语法高亮的一系列颜色配置。 | ... |

---

## 📄 许可证 (License)
本项目采用 MIT 许可证。详情请查看 `LICENSE` 文件。
This project is licensed under the MIT License. See the `LICENSE` file for details.