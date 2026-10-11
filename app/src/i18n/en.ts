import common from './en/common.ts';
import home from './en/home.ts';
import onboarding from './en/onboarding.ts';
import guides from './en/guides.ts';
import alertSettings from './en/alert-settings.ts';
import settings from './en/settings.ts';
import viewing from './en/viewing.ts';
import alerts from './en/alerts.ts';
import ask from './en/ask.ts';
import systems from './en/systems.ts';
import exporting from './en/exporting.ts';
import wall from './en/wall.ts';

/** English is the source language: every other language must have exactly these keys. */
export const en = {
  common,
  home,
  onboarding,
  guides,
  alertSettings,
  settings,
  viewing,
  alerts,
  ask,
  systems,
  exporting,
  wall,
};

export type Strings = typeof en;
