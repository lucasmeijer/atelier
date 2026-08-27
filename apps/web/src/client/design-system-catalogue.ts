import { Application } from "@hotwired/stimulus";
import { registerDesignSystemControllers } from "./design-system.ts";

const application = Application.start();
registerDesignSystemControllers(application);
