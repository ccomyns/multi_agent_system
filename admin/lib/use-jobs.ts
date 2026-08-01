"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { JobsSnapshot } from "@/lib/jobs";
import { fetchJobs, isActiveJob, requestJobEnd, requestJobLaunch } from "@/lib/jobs";

const ACTIVE_POLL_INTERVAL_MS = 8000;

type JobsStore = {
  snapshot: JobsSnapshot | null;
  error: string | null;
  pending: boolean;
};

// The job table is an external system shared by every page, so it lives outside
// React and components subscribe to it.
const EMPTY_STORE: JobsStore = { snapshot: null, error: null, pending: false };

let store: JobsStore = EMPTY_STORE;
let inFlightRefresh: Promise<void> | null = null;
const listeners = new Set<() => void>();

function updateStore(changes: Partial<JobsStore>) {
  store = { ...store, ...changes };
  for (const listener of listeners) {
    listener();
  }
}

function subscribeToStore(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getStore() {
  return store;
}

function getServerStore() {
  return EMPTY_STORE;
}

function describeError(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

export function refreshJobs() {
  inFlightRefresh ??= (async () => {
    try {
      updateStore({ snapshot: await fetchJobs(), error: null });
    } catch (caught) {
      updateStore({ error: describeError(caught, "The job table could not be read.") });
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

export async function launchJob(originalTask: string) {
  updateStore({ pending: true, error: null });
  try {
    await requestJobLaunch(originalTask);
    return true;
  } catch (caught) {
    updateStore({ error: describeError(caught, "The job could not be launched.") });
    return false;
  } finally {
    updateStore({ pending: false });
    await refreshJobs();
  }
}

export async function endJob(jobId: string) {
  updateStore({ pending: true, error: null });
  try {
    await requestJobEnd(jobId);
    return true;
  } catch (caught) {
    updateStore({ error: describeError(caught, "The job could not be ended.") });
    return false;
  } finally {
    updateStore({ pending: false });
    await refreshJobs();
  }
}

export function useJobs() {
  const { snapshot, error, pending } = useSyncExternalStore(
    subscribeToStore,
    getStore,
    getServerStore,
  );

  useEffect(() => {
    void refreshJobs();
  }, []);

  const jobs = snapshot?.jobs ?? [];
  const activeJob = jobs.find(isActiveJob) ?? null;
  const activeJobId = activeJob?.jobId ?? null;

  // An active job changes state on the orchestrator's schedule, not ours, so poll
  // only while one is in flight.
  useEffect(() => {
    if (activeJobId === null) {
      return;
    }
    const timer = window.setInterval(() => void refreshJobs(), ACTIVE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeJobId]);

  return {
    jobs,
    activeJob,
    hydrated: snapshot !== null,
    pending,
    error,
    refresh: refreshJobs,
    launch: launchJob,
    end: endJob,
  };
}
