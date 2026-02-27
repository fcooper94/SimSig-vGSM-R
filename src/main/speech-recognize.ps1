# speech-recognize.ps1
# Uses Windows built-in Speech Recognition with a constrained grammar
# for much better accuracy on known railway phrases.
# Usage: powershell -File speech-recognize.ps1 [-TimeoutSeconds 5]

param(
    [int]$TimeoutSeconds = 5
)

Add-Type -AssemblyName System.Speech

try {
    # Try en-GB for British railway terminology, fall back to system default
    try {
        $culture = New-Object System.Globalization.CultureInfo("en-GB")
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
    } catch {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    }

    # Build a grammar with specific railway reply phrases (much more accurate than dictation)
    $choices = New-Object System.Speech.Recognition.Choices
    $choices.Add("wait 2 minutes")
    $choices.Add("wait two minutes")
    $choices.Add("2 minutes")
    $choices.Add("two minutes")
    $choices.Add("wait 5 minutes")
    $choices.Add("wait five minutes")
    $choices.Add("5 minutes")
    $choices.Add("five minutes")
    $choices.Add("please 5 minutes")
    $choices.Add("wait 15 minutes")
    $choices.Add("wait fifteen minutes")
    $choices.Add("15 minutes")
    $choices.Add("fifteen minutes")
    $choices.Add("pass at danger")
    $choices.Add("pass signal at danger")
    $choices.Add("pass at stop")
    $choices.Add("authorise pass")
    $choices.Add("authorise driver to pass")
    $choices.Add("pass signal")
    $choices.Add("examine the line")
    $choices.Add("examine line")
    $choices.Add("pass and examine")
    $choices.Add("pass signal at stop and examine")
    $choices.Add("ok")
    $choices.Add("okay")
    $choices.Add("wait")
    $choices.Add("give him 2 minutes")
    $choices.Add("give him two minutes")
    $choices.Add("give him 5 minutes")
    $choices.Add("give him five minutes")
    $choices.Add("tell him to wait")
    $choices.Add("tell him to pass")
    $choices.Add("pass it")
    $choices.Add("let him pass")
    $choices.Add("yes")
    $choices.Add("no")
    # Goodbye phrases
    $choices.Add("bye")
    $choices.Add("bye bye")
    $choices.Add("goodbye")
    $choices.Add("thanks bye")
    $choices.Add("thanks bye bye")
    $choices.Add("thank you bye")
    $choices.Add("thank you goodbye")
    $choices.Add("cheers bye")
    $choices.Add("cheers bye bye")
    $choices.Add("cheers mate bye")
    $choices.Add("cheers mate")
    $choices.Add("ta bye")
    $choices.Add("ta bye bye")
    $choices.Add("thanks")
    $choices.Add("thank you")
    $choices.Add("cheers")
    $choices.Add("cheerio")
    # Place call phrases
    $choices.Add("request permission")
    $choices.Add("request permission to run")
    $choices.Add("cancel")
    $choices.Add("cancel all")
    $choices.Add("cancel acceptance")
    $choices.Add("cancel all acceptances")
    $choices.Add("please block")
    $choices.Add("block your signal")
    $choices.Add("block signal")
    $choices.Add("permission granted")
    $choices.Add("no obstruction")
    $choices.Add("continue normally")
    $choices.Add("hold")
    $choices.Add("hold it")
    $choices.Add("hold the train")
    $choices.Add("let it run")
    $choices.Add("let it continue")
    $choices.Add("run early")

    $builder = New-Object System.Speech.Recognition.GrammarBuilder
    $builder.Append($choices)

    $grammar = New-Object System.Speech.Recognition.Grammar($builder)
    $grammar.Weight = 1.0
    $engine.LoadGrammar($grammar)

    # Low-weight dictation fallback so we can at least hear SOMETHING
    $dictation = New-Object System.Speech.Recognition.DictationGrammar
    $dictation.Weight = 0.01
    $engine.LoadGrammar($dictation)

    $engine.SetInputToDefaultAudioDevice()

    # Give user time to finish speaking before cutting off
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(1500)
    $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(1000)

    $result = $engine.Recognize([TimeSpan]::FromSeconds($TimeoutSeconds))
    $engine.Dispose()

    if ($result -and $result.Text) {
        $text = $result.Text -replace '\\', '\\\\' -replace '"', '\"'
        $confidence = [math]::Round($result.Confidence, 2)
        Write-Output "{`"text`":`"$text`",`"confidence`":$confidence}"
    } else {
        Write-Output '{"text":""}'
    }
} catch {
    $msg = $_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
}
