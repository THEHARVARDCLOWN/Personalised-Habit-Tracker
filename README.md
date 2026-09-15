# Habit Tracker

<img src="build/icon.png" width="96" alt="Habit Tracker icon">

A personal weekly habit tracker for Windows. Check off habits each day, see your progress, and make it look the way you want.

## Features

- **Weekly tracker**: add habits with a target of 1–7 days a week and tick them off day by day. Move back and forth between weeks.
- **Analysis tab**: overall completion ring, completion by habit, weekly or monthly trend line, check-in rate by weekday and a calendar heatmap. Switch between Week, Month and All time.
- **Themes**: Light, Dark, Dusk and a Custom colour theme.
- **Custom background**: paste an image link or upload an image, with a dim slider to keep text readable.
- **Profile**: your name and photo at the top of the app.
- **Works offline**: everything is saved on your computer.

## Download

Get the latest `HabitTracker-x.x.x-portable.exe` from the [Releases](../../releases) page. It's portable: no installation, just double-click to run.

> Windows may show "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

## Build it yourself

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start        # run the app in development
npm run dist     # build dist/HabitTracker-<version>-portable.exe
```

## Project structure

```
src/app.jsx             React app
src/shell.html          Page layout and styles
scripts/build-html.js   Compiles the app into app/index.html (React bundled, works offline)
main.js                 Electron window
build/                  App icon
```

## Where your data lives

Habits, check-ins and settings are stored locally by the app on your PC. Nothing is uploaded anywhere.
