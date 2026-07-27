import { basename, extname } from "node:path";
import { recordAtelierDemo } from "./atelier-recording.ts";

const outputPath = process.argv[2] ?? "/work/artifacts/recording-harness-example.mp4";
const name = basename(outputPath, extname(outputPath));

const report = await recordAtelierDemo(
	{
		name,
		outputPath,
		timings: { afterActionMs: 350 },
	},
	async (recording) => {
		await recording.page.setContent(`
			<style>
				body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f0e8; font: 24px system-ui; }
				main { width: 620px; padding: 52px; border-radius: 24px; background: white; box-shadow: 0 20px 60px #25304722; }
				input, button { box-sizing: border-box; width: 100%; margin-top: 18px; padding: 16px; font: inherit; }
				button { color: white; border: 0; border-radius: 12px; background: #3157d5; }
				#result { color: #3157d5; font-weight: 700; }
			</style>
			<main>
				<h1>Atelier recording harness</h1>
				<label>Demo title <input aria-label="Demo title"></label>
				<button>Preview title</button>
				<p id="result"></p>
			</main>
			<script>
				document.querySelector("button").onclick = () => {
					document.querySelector("#result").textContent = document.querySelector("input").value;
				};
			</script>
		`);
		await recording.humanType(recording.page.getByLabel("Demo title"), "A clear product story");
		await recording.humanClick(recording.page.getByRole("button", { name: "Preview title" }));
		await recording.pauseAfterAction();
	},
);

console.log(JSON.stringify(report, null, 2));
