import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { switches } from './browser';

// The pacing that actually runs, for tests and field screenshots to confirm (PLAN.md §5.6).
document.documentElement.dataset.pacing = switches.pacing;

mount(App, { target: document.getElementById('app')! });
