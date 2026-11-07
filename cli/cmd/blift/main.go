// Command blift is the command-line client for the blift file-sharing service.
package main

import (
	"os"

	"github.com/davidliyutong/blift/cli/internal/cmd"
)

var version = "dev"

func main() { os.Exit(cmd.Execute(version)) }
