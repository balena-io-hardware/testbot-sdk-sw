#!/usr/bin/env bash

if [ "$1" == "dev" ]; then
  # This command is run in livepush mode to watch source file changes and re-run the tests.
  exec ./node_modules/.bin/jest -i --watchAll
elif [ "$1" == 'test' ]; then
  # Execute the test scenarios, we assume the working directory is the project root.
  # Jest is forced to run tests sequentially with -i option.
  exec ./node_modules/.bin/jest -i --testTimeout=700000
elif [ "$1" == 'repl-service' ]; then
  echo "Start REPL service"
  echo
  echo "To use the REPL, ssh into repl container and type"
  echo "    test/entry.sh repl"
  echo "in the command line."
  echo
  echo "Please note that REPL and test scenario cannot run simultaneously."

  # Infinite loop to keep the container alive.
  while true
  do
    sleep 2
  done

  echo "REPL service finished?"
  exit 1
elif [ "$1" == 'repl' ]; then
  echo "Starting REPL session with testbot..."
  script_path=$(dirname $0)
  script_path=$(cd $script_path && pwd)
  node $script_path/console.js
fi
