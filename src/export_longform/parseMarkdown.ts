import { notice_and_warn } from "./utils";
import {
	node,
	metadata_for_unroll,
	unroll_array,
	init_data,
	parsed_note,
	note_cache,
} from "./interfaces";
import {
	Paragraph,
	NumberedList,
	UnorderedList,
	parse_display,
	parse_after_headers,
} from "./display";
import { parse_inline } from "./inline";
import { Header, make_heading_tree, find_header } from "./headers";
import { TFile, Notice } from "obsidian";

// Describe label system
// If embedwikilink env, the label is an address to the embedded header, defaults to "statement" if no header is provided.
// If explicit env, parse for a label, otherwise it has no label.

/**
 * Plays the role of the zero'th header. Use this data structure when representing the markdown content of a file, or of some markdown with header structures.
 */
export type parsed_longform = {
	yaml: { [key: string]: string };
	abstract: string | undefined;
	body: string;
	appendix: string | undefined;
	media_files: TFile[];
	bib_keys: string[];
};

export async function parse_longform(
	read_tfile: (file: TFile) => Promise<string>,
	find_file: (address: string) => TFile | undefined,
	longform_file: TFile,
	selection?: string,
): Promise<parsed_longform> {
	if (longform_file === undefined) {
		throw new Error(`File not found: ${longform_file}`);
	}
	let file_contents: string;
	if (selection === undefined) {
		file_contents = await read_tfile(longform_file);
	} else {
		file_contents = selection;
	}
	const parsed_longform = parse_note(file_contents);
	const cache = {} as note_cache;
	cache[longform_file.basename] = parsed_longform;
	let parsed_content = parsed_longform.body;
	let abstract_header: Header | undefined;
	for (const e of parsed_content) {
		if (
			e instanceof Header &&
			(await e.latex_title()).toLowerCase().trim() === "abstract"
		) {
			abstract_header = e;
			parsed_content = parsed_content.filter((x) => x !== e);
		}
	}
	let appendix_header: Header | undefined;
	for (const e of parsed_content) {
		if (
			e instanceof Header &&
			(await e.latex_title()).toLowerCase().trim() === "appendix"
		) {
			appendix_header = e;
			parsed_content = parsed_content.filter((x) => x !== e);
		}
	}
	let body_header_content = parsed_content;
	let body_header: Header | undefined = undefined;
	for (const e of parsed_content) {
		if (
			e instanceof Header &&
			(await e.latex_title()).toLowerCase().trim() === "body"
		) {
			body_header = e;
			lower_headers([body_header]);
			body_header_content = e.children;
		}
	}

	// Must unroll all before rendering into latex so that at latex() time there is access to all
	// parsed files.
	const data = init_data(longform_file, read_tfile, find_file);
	data.parsed_file_bundle = cache;

	if (abstract_header !== undefined) {
		data.header_stack = [abstract_header];
	}
	const abstract_unrolled_content =
		abstract_header === undefined
			? undefined
			: await unroll_array(data, abstract_header.children);

	if (body_header !== undefined) {
		data.header_stack = [body_header];
	}
	const body_unrolled_content = await unroll_array(data, body_header_content);

	if (appendix_header !== undefined) {
		data.header_stack = [appendix_header];
	}
	const appendix_unrolled_content =
		appendix_header === undefined
			? undefined
			: await unroll_array(data, appendix_header.children);
	const abstract_string =
		abstract_unrolled_content === undefined
			? undefined
			: await render_content(data, abstract_unrolled_content);
	const body_string = await render_content(data, body_unrolled_content);
	const appendix_string =
		appendix_unrolled_content === undefined
			? undefined
			: await render_content(data, appendix_unrolled_content);
	return {
		yaml: parsed_longform.yaml,
		abstract: abstract_string,
		body: body_string,
		appendix: appendix_string,
		media_files: data.media_files,
		bib_keys: data.bib_keys,
	};
}

function lower_headers(content: node[]): void {
	for (const e of content) {
		if (e instanceof Header) {
			e.level -= 1;
			lower_headers(e.children);
		}
	}
}

async function render_content(
	data: metadata_for_unroll,
	content: node[],
): Promise<string> {
	const buffer = Buffer.alloc(10000000); // made this very big. Too big? For my paper I run out with two orders of magnitude smaller.
	let offset = 0;
	for (const elt of content) {
		offset = await elt.latex(buffer, offset);
	}
	return buffer.toString("utf8", 0, offset);
}

export async function export_selection(
	read_tfile: (file: TFile) => Promise<string>,
	find_file: (address: string) => TFile | undefined,
	longform_file: TFile,
	selection: string,
) {
	const parsed_contents = await parse_longform(
		read_tfile,
		find_file,
		longform_file,
		selection,
	);
	if (selection !== undefined) {
		const content = join_sections(parsed_contents);
		// copy content to clipboard
		await navigator.clipboard.writeText(content);
		new Notice("Latex content copied to clipboard");
		return;
	}
}

export async function write_with_template(
	template_file: TFile,
	parsed_contents: parsed_longform,
	output_file: TFile,
	modify_tfile: (file: TFile, content: string) => Promise<void>,
	read_tfile: (file: TFile) => Promise<string>,
) {
	let template_content = await read_tfile(template_file);
	for (const key of Object.keys(parsed_contents["yaml"])) {
		template_content = template_content.replace(
			RegExp(`\\\$${key}\\\$`, "i"),
			parsed_contents["yaml"][key],
		);
	}
	template_content = template_content.replace(
		/\$body\$/i,
		parsed_contents["body"],
	);
	if (parsed_contents["abstract"] !== undefined) {
		if (template_file) {
			template_content = template_content.replace(
				/\$abstract\$/i,
				parsed_contents["abstract"],
			);
		} else {
			template_content;
		}
	}
	if (parsed_contents["appendix"] !== undefined) {
		template_content = template_content.replace(
			/\$appendix\$/i,
			parsed_contents["appendix"],
		);
	}
	await modify_tfile(output_file, template_content);
}

function join_sections(parsed_contents: parsed_longform) {
	let content = "";
	if (parsed_contents["abstract"] !== undefined) {
		content =
			content +
			`\\begin{abstract}\n` +
			parsed_contents["abstract"] +
			`\\end{abstract}\n`;
	}
	content += parsed_contents["body"];
	if (parsed_contents["appendix"] !== undefined) {
		content += `\\printbibliography\n`;
		content += `\\appendix\n\\section{Appendix}\n` + parsed_contents["appendix"];
	}
	return content;
}

export async function write_without_template(
	parsed_contents: parsed_longform,
	output_file: TFile,
	modify: (file: TFile, content: string) => Promise<void>,
	preamble_file?: TFile,
) {
	let content = `\\documentclass{article}
\\input{header}\n`;
	if (preamble_file !== undefined) {
		content += "\\input{" + preamble_file.name + "}\n";
	}
	content += `\\addbibresource{bibliography.bib}\n`;
	content += `\\title{`
	if (parsed_contents["yaml"]["title"] !== undefined) {
		 content += parsed_contents["yaml"]["title"] 
	}
	content += `}\n`;
	if (parsed_contents["yaml"]["author"] !== undefined) {
		content += `\\author{` + parsed_contents["yaml"]["author"] + `}\n`;
	}
	content += `\\begin{document}
\\maketitle
`;
	if (parsed_contents["abstract"] !== undefined) {
		content =
			content +
			`\\begin{abstract}\n` +
			parsed_contents["abstract"] +
			`\\end{abstract}\n`;
	}
	content += parsed_contents["body"] + `\\printbibliography\n`;
	if (parsed_contents["appendix"] !== undefined) {
		content += `\\appendix\n\\section{Appendix}\n` + parsed_contents["appendix"];
	}
	content += "\\end{document}";
	await modify(output_file, content);
}

function traverse_tree_and_parse_display(md: node[]): node[] {
	const new_md: node[] = [];
	for (const elt of md) {
		if (elt instanceof Paragraph) {
			const parsed_objects = parse_after_headers([elt]);
			new_md.push(...parsed_objects);
		} else if (elt instanceof Header) {
			elt.children = traverse_tree_and_parse_display(elt.children);
			new_md.push(elt);
		} else {
			new_md.push(elt);
		}
	}
	return new_md;
}

function traverse_tree_and_parse_inline(md: node[]): void {
	for (const elt of md) {
		if (elt instanceof Header) {
			traverse_tree_and_parse_inline(elt.children);
			elt.title = parse_inline(elt.title);
		} else if (elt instanceof NumberedList) {
			for (const e of elt.content) {
				traverse_tree_and_parse_inline(e);
			}
		} else if (elt instanceof UnorderedList) {
			for (const e of elt.content) {
				traverse_tree_and_parse_inline(e);
			}
		} else if (elt instanceof Paragraph) {
			elt.elements = parse_inline(elt.elements);
		}
	}
}

export function parse_note(file_contents: string): parsed_note {
	const [yaml, body] = parse_display(file_contents);
	let parsed_contents = make_heading_tree(body);
	parsed_contents = traverse_tree_and_parse_display(parsed_contents);
	traverse_tree_and_parse_inline(parsed_contents);
	return { yaml: yaml, body: parsed_contents };
}

export async function parse_embed_content(
	address: string,
	find_file: (address: string) => TFile | undefined,
	read_tfile: (file: TFile) => Promise<string>,
	parsed_cache: note_cache,
	header?: string,
): Promise<[node[], number] | undefined> {
	const file_found = find_file(address);
	if (file_found === undefined) {
		// no warning necessary, already warned in find_file
		return undefined;
	}
	if (!(file_found.basename in Object.keys(parsed_cache))) {
		const file_contents = await read_tfile(file_found);
		parsed_cache[file_found.basename] = parse_note(file_contents);
	}
	const content =	parsed_cache[file_found.basename];
	if (content === undefined) {
		return undefined;
	}
	if (header === undefined) {
		return [content.body, 0];
	}
	const header_elt = await find_header(header, [content.body]);
	if (header_elt === undefined) {
		notice_and_warn(
			"Header not found: "+
			header+
			" in file with address "+
			address
		);
		return undefined;
	}
	return [header_elt.children, header_elt.level];
}

// There seems to be too many elements here, some should be inline.
