import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		publishedAt: z.coerce.date(),
		author: z.string().default('The Hidden Lodge'),
		tags: z.array(z.string()).optional().default([]),
	}),
});

export const collections = { articles };
