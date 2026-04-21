/**
 * onboarding-actions.ts — API call logic for the onboarding wizard
 */

import { AGENT_ID } from './constants';

export type HanaFetch = (path: string, opts?: RequestInit) => Promise<Response>;

// ── Test connection ──

interface TestConnectionParams {
  hanaFetch: HanaFetch;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  text: string;
}

export async function testConnection({ hanaFetch, providerUrl, providerApi, apiKey }: TestConnectionParams): Promise<TestResult> {
  const res = await hanaFetch('/api/providers/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    return { ok: true, text: t('onboarding.provider.testSuccess') };
  }
  return { ok: false, text: t('onboarding.provider.testFailed') };
}

// ── Save provider ──

interface SaveProviderParams {
  hanaFetch: HanaFetch;
  providerName: string;
  providerUrl: string;
  apiKey: string;
  providerApi: string;
}

export async function saveProvider({ hanaFetch, providerName, providerUrl, apiKey, providerApi }: SaveProviderParams): Promise<void> {
  await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api: { provider: providerName },
      providers: {
        [providerName]: {
          base_url: providerUrl,
          api_key: apiKey,
          api: providerApi,
        },
      },
    }),
  });
}

// ── Load models ──

interface LoadModelsParams {
  hanaFetch: HanaFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
}

export interface LoadModelsResult {
  models: { id: string }[];
  error?: string;
}

export async function loadModels({ hanaFetch, providerName, providerUrl, providerApi, apiKey }: LoadModelsParams): Promise<LoadModelsResult> {
  const res = await hanaFetch('/api/providers/fetch-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: providerName,
      base_url: providerUrl,
      api: providerApi,
      api_key: apiKey,
    }),
  });
  const data = await res.json();
  if (data.error) {
    return { models: [], error: data.error };
  }
  return { models: data.models || [] };
}

// ── Save model + utility models ──

interface SaveModelParams {
  hanaFetch: HanaFetch;
  selectedModel: string;
  fetchedModels: { id: string }[];
  providerName: string;
  selectedUtility: string;
  selectedUtilityLarge: string;
}

export async function saveModel({ hanaFetch, selectedModel, fetchedModels, providerName, selectedUtility, selectedUtilityLarge }: SaveModelParams): Promise<void> {
  // Save chat model
  await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ models: { chat: { id: selectedModel, provider: providerName } } }),
  });

  // Save model list to provider
  const modelIds = fetchedModels.map(m => m.id);
  await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providers: { [providerName]: { models: modelIds } },
    }),
  });

  // Save utility models to global preferences
  if (selectedUtility || selectedUtilityLarge) {
    const utilityModels: Record<string, { id: string; provider: string }> = {};
    if (selectedUtility) utilityModels.utility = { id: selectedUtility, provider: providerName };
    if (selectedUtilityLarge) utilityModels.utility_large = { id: selectedUtilityLarge, provider: providerName };
    await hanaFetch('/api/preferences/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: utilityModels }),
    });
  }
}

// ── Save locale ──

export async function saveLocale(hanaFetch: HanaFetch, locale: string): Promise<void> {
  await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale }),
  });
}

// ── Save user name ──

export async function saveUserName(hanaFetch: HanaFetch, name: string): Promise<void> {
  await hanaFetch(`/api/agents/${AGENT_ID}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: { name } }),
  });
}
