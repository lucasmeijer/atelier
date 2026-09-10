CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -Werror

SOURCE = ../../packages/workspace-terminal/src/server/intro/main.c

atelier-intro: $(SOURCE)
	$(CC) $(CFLAGS) $(SOURCE) -o $@ -lm

.PHONY: clean
clean:
	rm -f atelier-intro
