import { defineCollection, z } from "astro:content";

const postsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		published: z.date(),
		updated: z.date().optional(),
		draft: z.boolean().optional().default(false),
		description: z.string().optional().default(""),
		image: z.string().optional().default(""),
		tags: z.array(z.string()).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),

		/* For internal use */
		prevTitle: z.string().default(""),
		prevSlug: z.string().default(""),
		nextTitle: z.string().default(""),
		nextSlug: z.string().default(""),
	}),
});
const specCollection = defineCollection({
	schema: z.object({}),
});
const methodologyCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		episode: z.string().optional().default(""),
		oneLiner: z.string().optional().default(""),
		categories: z.array(z.string()).optional().default([]),
		tags: z.array(z.string()).optional().default([]),
		maoxuanRef: z.string().optional().default(""),
		sourceFile: z.string().optional().default(""),
		published: z.date(),
	}),
});
const projectsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		oneLiner: z.string().optional().default(""),
		role: z.string().optional().default(""),
		period: z.string().optional().default(""),
		status: z.enum(["进行中", "已完成", "搁置"]).optional().default("进行中"),
		tags: z.array(z.string()).optional().default([]),
		highlights: z.array(z.string()).optional().default([]),
		links: z
			.array(
				z.object({
					name: z.string(),
					url: z.string(),
				}),
			)
			.optional()
			.default([]),
		order: z.number().optional().default(0),
	}),
});
export const collections = {
	posts: postsCollection,
	spec: specCollection,
	methodology: methodologyCollection,
	projects: projectsCollection,
};
