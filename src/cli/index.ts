#!/usr/bin/env node
import { runMain } from "citty"
import { cli } from "./command"

await runMain(cli)
