jest.mock("obsidian");
import { get_latex_file_contents, get_unrolled_file_contents } from "./test_utils";

describe("my plugin", () => {
	test("Quote", async () => {
		const result = await get_latex_file_contents("quote")
		expect(result).toEqual(`Hi I speak
% And here is a quote
% again
I speak more
`)
	})
});
