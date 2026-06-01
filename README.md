# ytomp3 — Premium YouTube Media Converter

[![Astro](https://img.shields.io/badge/Astro-v6.0-BC52EE?style=flat&logo=astro&logoColor=white)](https://astro.build)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4.0-38B2AC?style=flat&logo=tailwind-css&logoColor=white)](https://tailwindcss.com)
[![Vercel Design](https://img.shields.io/badge/Design_Language-Vercel-171717?style=flat&logo=vercel&logoColor=white)](https://vercel.com)
[![Build Status](https://img.shields.io/badge/Build-Static-green?style=flat)](#-commands)

A modern, high-performance, premium-quality YouTube to MP3 and MP4 media converter website built for **ytomp3.in**. The project features a stark, minimal Vercel-inspired canvas, atmospheric mesh gradients, custom Geist/Inter typography, stacked box-shadow elevations, and custom state machines.

---

## ⚡ Key Highlights & Differences (vs Competitors)

Unlike standard, ad-heavy legacy converters like `yt2mp3.ai`, this project focuses heavily on visual excellence, performance, and user customization:

- ** Design Language**: Clean white/ink canvases, customized font hierarchy, flat-rounded interfaces, and dynamic backdrops.
- **Custom Quality Selection**: Choose specific audio bitrates (128kbps, 192kbps, 256kbps, 320kbps CBR) and video resolutions (360p, 480p, 720p HD, 1080p Full HD).
- **Interactive State Transitions**: Smooth, animated progress bar feedback detailing exact conversion stages (Metadata parsing → Stream extraction → Packaging containers → Compilation).
- **Pre-fill Conversions (Bookmarklet & Extension)**: Built-in support to drag-and-drop bookmarklet code into bookmark bars to launch conversions with one click while watching YouTube.
- **Privacy & Security Focused**: Zero sign-ups, no registration, no Java/Flash dependencies, and clean streams.
- **Fully SEO Optimized**: Complete JSON-LD schema markup, Google Font preconnect tags, descriptive title structures, and clean canonical routing.

---

## 📁 Project Structure

```text
/
├── public/                  # Static assets
│   ├── favicon.svg          # Minimal brand favicon mark
│   └── og-image.png         # Social sharing preview banner
├── src/
│   ├── components/          # Reusable UI widgets
│   │   ├── ConverterWidget.astro  # State machine conversion form
│   │   ├── FAQ.astro        # Expandable Q&A accordion list
│   │   ├── Features.astro   # Core selling point card sections
│   │   ├── Footer.astro     # 4-column structured footer
│   │   ├── Hero.astro       # Header banner containing mesh backdrops
│   │   ├── HowItWorks.astro # Visual workflow steps
│   │   ├── Navbar.astro     # Sticky navigation & responsive mobile drawer
│   │   └── SupportedFormats.astro  # Dark polarity-flipped spec details
│   ├── layouts/
│   │   └── Layout.astro     # HTML5 semantic wrapper with full SEO meta tags
│   ├── pages/               # Routing directories
│   │   ├── index.astro      # Main landing page
│   │   ├── faq.astro        # Troubleshooting guidelines page
│   │   ├── add-on.astro     # Extension and bookmarklet details page
│   │   ├── contact.astro    # Feedback/bug submission form page
│   │   ├── privacy-policy.astro  # Data security compliance policy
│   │   ├── terms-of-use.astro    # Acceptable usage guidelines
│   │   └── dmca.astro       # Copyright infringement takedown guide
│   └── styles/
│       └── app.css          # Tailwind CSS v4 entrypoint + design system variables
├── astro.config.mjs         # Astro & Vite plugin configuration
├── package.json             # Dependencies and build script tasks
└── tsconfig.json            # TypeScript type safety configuration
```

---

## 🚀 Getting Started

### 📋 Prerequisites
- **Node.js**: `v22.12.0` or higher
- **npm**: `v10` or higher

### ⚙️ Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd ytomp3
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the local development server:
   ```bash
   npm run dev
   ```
   Open your browser to [http://localhost:4321/](http://localhost:4321) to view the application running.

---

## 🧞 Build and Production Deployment

Astro builds the website as a fully-optimized, zero-JS-by-default static site under the `/dist` directory.

| Command | Action |
|:---|:---|
| `npm run dev` | Starts local dev server at `localhost:4321` (w/ hot reload) |
| `npm run build` | Builds your production static site to `./dist/` |
| `npm run preview` | Previews the compiled production build locally before hosting |
| `npm run astro ...` | Runs other Astro CLI commands (e.g. check, add) |

---

## 💻 Tech Stack & Design Tokens

This project utilizes custom values from [DESIGN.md](DESIGN.md) configured via Tailwind CSS v4's new CSS-first design system (`@theme` block in [app.css](src/styles/app.css))

---

## 🔗 How the Bookmarklet Works

The bookmarklet allows users to convert current YouTube tabs instantly by clicking a browser shortcut. The Javascript code block executing this operation is:

```javascript
javascript:(function(){
  var url = window.location.href;
  if(url.indexOf('youtube.com/watch') !== -1){
    window.open('https://ytomp3.in/?url=' + encodeURIComponent(url));
  } else {
    alert('Drag this to your bookmarks, then click it while watching a YouTube video!');
  }
})();
```

Users can drag this script directly to their bookmarks bar from the **Bookmarklet / Extension** subpage.
