// webview-ui/main.js
(function () {
    const vscode = acquireVsCodeApi();

    // 状态管理
    const state = {
        modPathSet: false,
        dictionarySet: false,
        indexingSet: false
    };

    // 元素获取
    const useWorkspaceBtn = document.getElementById('use-workspace-btn');
    const browseFolderBtn = document.getElementById('browse-folder-btn');
    const downloadDictBtn = document.getElementById('download-dict-btn');
    const selectDictBtn = document.getElementById('select-dict-btn');
    const customizeIndexingBtn = document.getElementById('customize-indexing-btn');
    const finishBtn = document.getElementById('finish-btn');
    const mainContainer = document.querySelector('.main-container');

    const modPathInput = document.getElementById('mod-path-input');
    const dictPathInput = document.getElementById('dict-path-input');
    const indexingPatternsInput = document.getElementById('indexing-patterns-input');

    const progressNodes = {
        1: document.getElementById('progress-node-1'),
        2: document.getElementById('progress-node-2'),
        3: document.getElementById('progress-node-3')
    };

    function updateProgressNode(stepNumber, isCompleted) {
        const progressNode = progressNodes[stepNumber];
        if (progressNode) {
            if (isCompleted) {
                progressNode.classList.add('completed');
            } else {
                progressNode.classList.remove('completed');
            }
        }
    }

    function checkFinishable() {
        if (state.modPathSet) {
            finishBtn.classList.add('ready');
        } else {
            finishBtn.classList.remove('ready');
        }
    }

    // 事件监听
    modPathInput.addEventListener('input', (e) => {
        const value = e.target.value;
        vscode.postMessage({ command: 'updateConfig', key: 'validationFolderPath', value });
        state.modPathSet = !!value;
        updateProgressNode(1, state.modPathSet);
        checkFinishable();
    });

    dictPathInput.addEventListener('input', (e) => {
        const value = e.target.value;
        vscode.postMessage({ command: 'updateConfig', key: 'schemaFilePath', value });
        state.dictionarySet = !!value;
        updateProgressNode(2, state.dictionarySet);
    });

    indexingPatternsInput.addEventListener('input', (e) => {
        const value = e.target.value;
        vscode.postMessage({ command: 'updateConfig', key: 'indexing.includePatterns', value });
        state.indexingSet = !!value;
        updateProgressNode(3, state.indexingSet);
    });

    useWorkspaceBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectModPath', useWorkspaceFolder: true });
    });

    browseFolderBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectModPath', useWorkspaceFolder: false });
    });

    downloadDictBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'downloadDictionary' });
    });

    selectDictBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectDictionary' });
    });

    customizeIndexingBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'openSettings' });
    });

    finishBtn.addEventListener('click', () => {
        if (finishBtn.classList.contains('ready')) {
            mainContainer.classList.add('fade-out');
            setTimeout(() => {
                vscode.postMessage({ command: 'closeWelcome' });
            }, 500);
        }
    });

    // 监听来自扩展的消息
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'initialConfig':
                const { modPath, dictPath, includePatterns, defaultIncludePatterns } = message.config;

                modPathInput.value = modPath;
                state.modPathSet = !!modPath;
                updateProgressNode(1, state.modPathSet);

                dictPathInput.value = dictPath;
                state.dictionarySet = !!dictPath;
                updateProgressNode(2, state.dictionarySet);

                const patternsToShow = includePatterns || defaultIncludePatterns;
                indexingPatternsInput.value = patternsToShow;
                state.indexingSet = !!patternsToShow;
                updateProgressNode(3, state.indexingSet);

                checkFinishable();
                break;

            case 'pathSelected':
                modPathInput.value = message.path;
                modPathInput.dispatchEvent(new Event('input', { bubbles: true }));
                break;

            case 'dictionarySelected':
                dictPathInput.value = message.path;
                dictPathInput.dispatchEvent(new Event('input', { bubbles: true }));
                break;

            case 'downloadFinished':
                dictPathInput.value = message.path;
                dictPathInput.dispatchEvent(new Event('input', { bubbles: true }));
                break;
        }
    });

    // 初始化加载动画
    const animatedElements = document.querySelectorAll('.animated');
    animatedElements.forEach((el, index) => {
        setTimeout(() => {
            el.classList.add('visible');
        }, 100 + index * 100);
    });

})();