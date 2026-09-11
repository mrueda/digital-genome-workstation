/* Native Linux entry point for the portable graphical installer.
 * Copyright 2026 Manuel Rueda. SPDX-License-Identifier: Apache-2.0
 */
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char path[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (length < 0 || length >= (ssize_t)sizeof(path) - 1) {
        fprintf(stderr, "DGW: cannot locate the installer executable.\n");
        return 1;
    }
    path[length] = '\0';
    char *last = strrchr(path, '/');
    if (!last) return 1;
    *last = '\0';
    const char suffix[] = "/.dgw.AppDir/AppRun";
    if (strlen(path) + sizeof(suffix) > sizeof(path)) {
        fprintf(stderr, "DGW: installer path is too long.\n");
        return 1;
    }
    strcat(path, suffix);
    char **args = calloc((size_t)argc + 1, sizeof(char *));
    if (!args) return 1;
    args[0] = path;
    for (int i = 1; i < argc; ++i) args[i] = argv[i];
    /* Let the bundled launcher configure its own resource directory. */
    unsetenv("APPDIR");
    unsetenv("APPIMAGE");
    execv(path, args);
    fprintf(stderr, "DGW: cannot start the bundled installer: %s. "
                    "Extract the complete package and keep its files together.\n", strerror(errno));
    free(args);
    return 1;
}
