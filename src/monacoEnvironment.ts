import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};
