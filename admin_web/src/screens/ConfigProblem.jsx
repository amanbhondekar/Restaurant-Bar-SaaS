import React from 'react';
import { Notice } from '@/admin/ui';
import { Frame } from './parts';

/** Shown instead of the console when the page was built with settings it cannot work with. It names the settings, never their values. */
export function ConfigProblem({ problems }) {
  return (
    <Frame title="This console is not set up">
      <Notice tone="error">The page was built without the settings it needs, so it will not start.</Notice>
      <ul className="list-disc pl-5 text-sm">
        {problems.map(problem => <li key={problem}>{problem}</li>)}
      </ul>
    </Frame>
  );
}
