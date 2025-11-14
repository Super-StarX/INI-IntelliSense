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
    const useDefaultIndexingBtn = document.getElementById('use-default-indexing-btn');
    const customizeIndexingBtn = document.getElementById('customize-indexing-btn');
    const finishBtn = document.getElementById('finish-btn');
    const mainContainer = document.querySelector('.main-container');

    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');

    const progressNodes = {
        1: document.getElementById('progress-node-1'),
        2: document.getElementById('progress-node-2'),
        3: document.getElementById('progress-node-3')
    };

    // 通用状态更新函数
    function updateStepStatus(stepNumber, status, message) {
        const stepElement = document.getElementById(`step${stepNumber}`);
        if (!stepElement) return;

        stepElement.className = 'step-module'; // Reset classes
        stepElement.classList.add(status); // 'pending', 'loading', 'done'
        
        const resultEl = stepElement.querySelector('.result');
        if (resultEl) {
            resultEl.textContent = message || '';
        }

        const redoBtn = stepElement.querySelector('.redo-btn');
        if(redoBtn) {
            redoBtn.style.display = (status === 'done') ? 'inline-flex' : 'none';
        }
        
        // 更新对应的进度节点状态
        const progressNode = progressNodes[stepNumber];
        if(progressNode) {
            progressNode.classList.remove('active', 'completed');
            if(status === 'done') {
                progressNode.classList.add('completed');
            }
        }
        
        checkFinishable();
    }
    
    // 检查是否可以完成配置
    function checkFinishable() {
        if (state.modPathSet) { // 核心条件：只要设置了Mod根目录即可完成
            finishBtn.classList.add('ready');
        } else {
            finishBtn.classList.remove('ready');
        }
    }

    function handleRedo(stepNumber) {
        if (stepNumber === 1) {
            state.modPathSet = false;
            updateStepStatus(1, 'pending', '');
        } else if (stepNumber === 2) {
            state.dictionarySet = false;
            updateStepStatus(2, 'pending', '');
        } else if (stepNumber === 3) {
            state.indexingSet = false;
            updateStepStatus(3, 'pending', '');
        }
    }

    // 事件监听
    useWorkspaceBtn.addEventListener('click', () => {
        updateStepStatus(1, 'loading', '等待文件夹选择...');
        vscode.postMessage({ command: 'selectModPath', useWorkspaceFolder: true });
    });

    browseFolderBtn.addEventListener('click', () => {
        updateStepStatus(1, 'loading', '等待文件夹选择...');
        vscode.postMessage({ command: 'selectModPath', useWorkspaceFolder: false });
    });

    downloadDictBtn.addEventListener('click', () => {
        updateStepStatus(2, 'loading', '正在从 GitHub 下载...');
        vscode.postMessage({ command: 'downloadDictionary' });
    });

    selectDictBtn.addEventListener('click', () => {
        updateStepStatus(2, 'loading', '等待文件选择...');
        vscode.postMessage({ command: 'selectDictionary' });
    });
    
    useDefaultIndexingBtn.addEventListener('click', () => {
        state.indexingSet = true;
        updateStepStatus(3, 'done', '已使用默认规则。');
    });

    customizeIndexingBtn.addEventListener('click', () => {
        state.indexingSet = true;
        vscode.postMessage({ command: 'openSettings' });
        updateStepStatus(3, 'done', '设置页面已打开，您可稍后配置。');
    });

    finishBtn.addEventListener('click', () => {
        if (finishBtn.classList.contains('ready')) {
            mainContainer.classList.add('fade-out');
            setTimeout(() => {
                 vscode.postMessage({ command: 'closeWelcome' });
            }, 500);
        }
    });
    
    document.querySelectorAll('.redo-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const step = parseInt(e.currentTarget.getAttribute('data-step'));
            handleRedo(step);
        });
    });

    // 监听来自扩展的消息
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'pathSelected':
                state.modPathSet = true;
                updateStepStatus(1, 'done', `路径: ${message.path}`);
                break;
            case 'pathSelectionFailed':
                 updateStepStatus(1, 'pending', '选择已取消或失败。');
                 break;
            case 'downloadFinished':
                state.dictionarySet = true;
                updateStepStatus(2, 'done', `已下载至: ${message.path}`);
                break;
            case 'downloadFailed':
                updateStepStatus(2, 'pending', `下载失败: ${message.error}`);
                break;
            case 'dictionarySelected':
                state.dictionarySet = true;
                updateStepStatus(2, 'done', `已选择: ${message.path}`);
                break;
            case 'dictionarySelectionFailed':
                updateStepStatus(2, 'pending', '选择已取消。');
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