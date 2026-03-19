import { useEffect } from 'react';
import { initBridge } from './bridge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivityPanel } from './components/ActivityPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { BridgePanel } from './components/BridgePanel';
import { PreviewPanel } from './components/PreviewPanel';
import { BrowserCard } from './components/BrowserCard';
import { DeskSection } from './components/DeskSection';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';

function App() {
  useEffect(() => {
    const cleanupBridge = initBridge();

    // app.js 中 init() 被 __REACT_MANAGED 阻止了自动调用，
    // 现在 React 已 mount，调用它
    window.__hanaInit?.().catch((err: unknown) => {
      console.error('[init] 初始化异常:', err);
      window.platform?.appReady?.();
    });

    return cleanupBridge;
  }, []);

  return (
    <ErrorBoundary>
      <ActivityPanel />
      <AutomationPanel />
      <BridgePanel />
      <PreviewPanel />
      <BrowserCard />
      <DeskSection />
      <InputArea />
      <SessionList />
      <WelcomeScreen />
      <ChatArea />
    </ErrorBoundary>
  );
}

export default App;
