import fs from 'fs';
import path from 'path';

const siteUrl = process.env.SITE_URL;
if (siteUrl) {
  const cleanSiteUrl = siteUrl.replace(/\/$/, '');
  const distClientDir = path.join(process.cwd(), 'dist', 'client');
  const filesToUpdate = ['robots.txt', 'sitemap.xml'];

  for (const filename of filesToUpdate) {
    const filePath = path.join(distClientDir, filename);
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      content = content.replaceAll('https://yttomp3-converter.onrender.com', cleanSiteUrl);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`[Postbuild] Successfully updated URLs in ${filename} to ${cleanSiteUrl}`);
    }
  }
} else {
  console.log('[Postbuild] SITE_URL env variable not set. Keeping default Render URLs in sitemap and robots.txt.');
}
