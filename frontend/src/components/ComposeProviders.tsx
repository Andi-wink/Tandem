'use client';

import React from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderEntry = [React.ComponentType<any>, Record<string, unknown>?];

/**
 * R010: Flatten the provider nesting pyramid in layout.tsx.
 *
 * Usage:
 *   <ComposeProviders providers={[
 *     [ThemeProvider, { attribute: "class" }],
 *     [AnalyticsProvider],
 *     [RecordingStateProvider],
 *   ]}>
 *     {children}
 *   </ComposeProviders>
 */
export function ComposeProviders({
  providers,
  children,
}: {
  providers: ProviderEntry[];
  children: React.ReactNode;
}) {
  return providers.reduceRight<React.ReactNode>(
    (acc, [Provider, props]) => <Provider {...(props ?? {})}>{acc}</Provider>,
    children,
  ) as React.ReactElement;
}
