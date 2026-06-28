function __dwiw_cli
    if set -q DWIW_SCRIPT; and test -n "$DWIW_SCRIPT"
        command $DWIW_EXEC $DWIW_SCRIPT $argv
    else
        command $DWIW_EXEC $argv
    end
end

function __dwiw_on_enter
    set -l line (commandline)
    set -l trimmed (string trim -- "$line")
    if test -z "$trimmed"
        commandline -f execute
        return
    end
    if string match -q -- '*'\n'*' "$line"
        commandline -f execute
        return
    end
    set -l first (string split -m1 ' ' -- $trimmed)[1]
    switch $first
        case for while if else switch case begin end function and or not return break continue
            commandline -f execute
            return
    end
    set -l out (__dwiw_cli route -- "$line")
    if test (count $out) -eq 0
        commandline -f execute
        return
    end
    set -l kind $out[1]
    set -l norm (string join \n -- $out[2..-1])
    switch $kind
        case intent
            commandline -r ''
            commandline -f repaint
            echo
            set -l res (__dwiw_cli ask --cwd "$PWD" -- "$norm")
            set -l verb $res[1]
            set -l cmd (string join \n -- $res[2..-1])
            if test "$verb" = RUN; and test -n (string trim -- "$cmd")
                commandline -r -- "$cmd"
                commandline -f execute
            else if test "$verb" = EDIT; and test -n (string trim -- "$cmd")
                commandline -r -- "$cmd"
                commandline -f repaint
            end
        case command
            if test "$norm" != "$line"
                commandline -r -- "$norm"
            end
            commandline -f execute
        case '*'
            commandline -f execute
    end
end

functions -q __dwiw_orig_fish_prompt; or functions -c fish_prompt __dwiw_orig_fish_prompt
function fish_prompt
    printf '\e]133;A\a'
    __dwiw_orig_fish_prompt
    printf '\e]133;B\a'
end

function __dwiw_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end

function __dwiw_postexec --on-event fish_postexec
    set -l code $status
    printf '\e]133;D;%s\a' $code
end

bind \r __dwiw_on_enter 2>/dev/null
bind \cm __dwiw_on_enter 2>/dev/null
