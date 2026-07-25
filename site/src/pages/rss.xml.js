import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { BUSINESS } from '../config';

export async function GET(context) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );
  return rss({
    title: `${BUSINESS.name} — Resources`,
    description: 'Plain-English bookkeeping, QuickBooks, and cash-flow guides for Texas small businesses.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/resources/${post.id}/`,
    })),
  });
}
