# INI Intellisense for VS Code  
**INI Intellisense** 是一个主要服务于《命令与征服:红色警戒2》 mod开发的功能强大的 Visual Studio Code 扩展，用于提高您在 `.ini` 配置文件上的工作效率。它提供高级功能，如语法高亮、悬停提示、诊断检查和折叠功能，帮助您更轻松地书写、阅读和维护 `.ini` 文件。  

**INI Intellisense** is a powerful Visual Studio Code extension designed to enhance your workflow when working with `.ini` configuration files. It provides advanced features such as syntax highlighting, hover tooltips, diagnostics, and folding, making it easier to write, read, and maintain `.ini` files.

---

## Features 功能  

### 1. **Syntax Highlighting 语法高亮**  
- 支持自定义颜色，用于区分键、值、括号和注释。  
- 支持复杂语法，例如 `[]:[]` 节点、多层嵌套键和值、内联注释等。  

- Customizable colors for keys, values, brackets, and comments.  
- Supports complex patterns such as `[]:[]` sections, nested keys, and inline comments.

### 2. **Hover Tooltips 悬停提示**  
- 悬停在值上时显示关联的节注释或内联描述。  
- 支持多行注释，并自动检测注释的正确位置。  

- Displays comments or descriptions associated with sections or values.  
- Supports multi-line comments, either above or inline with the section.

### 3. **Diagnostics 诊断检查**  
- 实时检查常见问题：  
  - 等号两侧的多余空格。  
  - 行首的多余空格。  
  - 注释前缺少空格。  
  - 注释后多余的空格。  

- Indicate common issues:  
  - Spaces around `=` (assignment operator).  
  - Leading spaces at the beginning of lines.  
  - Missing spaces before comments (`;`).  
  - Extra spaces after comments.

### 4. **Folding 折叠功能**  
- 支持基于节的折叠，包括复杂的 `[]:[]` 语法。  
- 自动检测并管理嵌套的节范围。  

- Collapse sections based on their scope, including complex `[]:[]` syntax.  
- Supports nested sections.

### 5. **Jump to Definition 跳转到定义**  
- 按住 `Ctrl` 并单击键或值，即可跳转到对应的节。  
- 支持跨文件跳转到 `.ini` 节点。  

- Press `Ctrl` and click on a key or value to jump to its corresponding section.  
- Works across the same or external `.ini` files.

---

## Installation 安装  

1. 克隆本仓库或下载 `.vsix` 文件。  
2. 在 VS Code 中安装扩展：  
   - 打开扩展面板（`Ctrl+Shift+X`）。  
   - 点击右上角的三点菜单，选择“从 VSIX 安装...”。  
   - 选择 `.vsix` 文件。  
3. 重新加载 VS Code。  
>
1. Clone the repository or download the `.vsix` file.  
2. Install the extension in VS Code:  
   - Go to Extensions (`Ctrl+Shift+X`).  
   - Click on the three dots (`...`) at the top right and select "Install from VSIX...".  
   - Choose the `.vsix` file.  
3. Reload VS Code.

---

## Usage 使用方法  

### Syntax Highlighting 语法高亮  
打开 `.ini` 文件后，语法高亮会自动生效。  
Open any `.ini` file, and the syntax highlighting will be automatically applied.

### Hover Tooltips 悬停提示  
悬停在值上以查看关联的节注释或内联描述。  
Hover over a value to view its associated section comment or inline description.

### Diagnostics 诊断检查  
编辑器中会实时标记问题，并显示详细错误信息。  
Issues will be underlined with a red wavy line in the editor. Hover over the line to see a detailed error message.

### Jump to Definition 跳转到定义  
按 `Ctrl + 单击` 键或值即可跳转到对应的节。  
`Ctrl + Click` on a key or value to navigate to its section.

### Folding 折叠功能  
点击节旁边的折叠图标以折叠或展开。  
Click on the folding icon next to a section to collapse or expand it.

---

## Configuration 配置  

### Custom Syntax Highlighting Colors 自定义语法高亮颜色  
在 VS Code 设置文件（`themes\settings.json`）中修改配色方案：  

Modify the color scheme in your VS Code settings (`themes\settings.json`):  

---

## License 许可证

本项目采用 MIT 许可证。详情请查看 LICENSE 文件。
This project is licensed under the MIT License. See the LICENSE file for details.