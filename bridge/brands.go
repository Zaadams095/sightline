package main

// Camera brands compiled into the Hub. Each package registers itself with backend.Register in
// its init(), which puts it on the setup page and lets saved systems start. Adding a brand is
// one line here (see backend/todo.go): uncomment yours. Each import is its own declaration,
// with blank lines between, so brands added in parallel merge cleanly.

import _ "github.com/zachadams/sightline/bridge/backend/frigate"

import _ "github.com/zachadams/sightline/bridge/backend/hikvision"

import _ "github.com/zachadams/sightline/bridge/backend/dahua"

import _ "github.com/zachadams/sightline/bridge/backend/reolink"

import _ "github.com/zachadams/sightline/bridge/backend/unifi"

import _ "github.com/zachadams/sightline/bridge/backend/onvif"

import _ "github.com/zachadams/sightline/bridge/backend/rtsp"
