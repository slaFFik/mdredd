import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { App } from './App.js';
import './styles.css';

const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
    <App />
  </Tooltip.Provider>,
);
