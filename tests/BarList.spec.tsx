import React from 'react';
import { test, expect } from 'vitest';
import { createRoot } from 'react-dom/client';
import BarList from '../src/components/BarList';

test('BarList renders items and values', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const data = [
    { label: 'A', value: 10 },
    { label: 'B', value: 5 },
  ];
  root.render(<BarList data={data} />);
  expect(container.textContent).toContain('A');
  expect(container.textContent).toContain('B');
  expect(container.textContent).toContain('10');
  root.unmount();
  document.body.removeChild(container);
});
