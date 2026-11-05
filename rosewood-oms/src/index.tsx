/// <reference types="@commercetools-frontend/application-config/client" />

import React from 'react';
import { createRoot } from 'react-dom/client';
import EntryPoint from './components/entry-point';

const container = document.getElementById('app');
const root = createRoot(container as Element);
root.render(React.createElement(EntryPoint));
