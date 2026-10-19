codeunit 50208 "BCD Conflict Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleModifyDoesNotOverwriteNewValue()
    begin
        CheckStale('modify');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleDeleteDoesNotRemoveNewValue()
    begin
        CheckStale('delete');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure StaleRenameDoesNotMoveNewValue()
    begin
        CheckStale('rename');
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure FreshRenamePreservesSystemIdThenFreshDeleteSucceeds()
    var
        RunId: Guid;
        BeforeState: JsonObject;
        AfterState: JsonObject;
        Token: JsonToken;
    begin
        RunId := CreateGuid();
        BeforeState.ReadFrom(Probe.Prepare(RunRequest(RunId)));
        Commit();
        AfterState.ReadFrom(Probe.Execute(Mutation(RunId, BeforeState, 'rename')));
        Commit();
        Assert.AreEqual(Value(BeforeState, 'systemId'), Value(AfterState, 'systemId'), 'Rename preserves identity.');
        Assert.AreEqual('RENAMED', Value(AfterState, 'name'), 'Fresh rename applies.');
        Assert.AreNotEqual(Value(BeforeState, 'version'), Value(AfterState, 'version'), 'Rename changes version.');
        Probe.Execute(Mutation(RunId, AfterState, 'delete'));
        Commit();
        Clear(AfterState);
        AfterState.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        AfterState.Get('exists', Token);
        Assert.IsFalse(Token.AsValue().AsBoolean(), 'Fresh delete removes row.');
        Probe.Cleanup(RunRequest(RunId));
    end;

    local procedure CheckStale(Operation: Text)
    var
        RunId: Guid;
        Original: JsonObject;
        Current: JsonObject;
        Actual: JsonObject;
    begin
        RunId := CreateGuid();
        Original.ReadFrom(Probe.Prepare(RunRequest(RunId)));
        Commit();
        Current.ReadFrom(Probe.Execute(Mutation(RunId, Original, 'modify')));
        Commit();
        asserterror Probe.Execute(Mutation(RunId, Original, Operation));
        Assert.ExpectedError('BCD_E04_CONFLICT');
        Actual.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        Assert.AreEqual(Value(Current, 'version'), Value(Actual, 'version'), 'Conflict leaves version unchanged.');
        Assert.AreEqual(Value(Current, 'name'), Value(Actual, 'name'), 'Conflict leaves name unchanged.');
        Assert.AreEqual(Value(Current, 'amount'), Value(Actual, 'amount'), 'Conflict leaves amount unchanged.');
        Probe.Cleanup(RunRequest(RunId));
    end;

    local procedure Mutation(RunId: Guid; State: JsonObject; Operation: Text): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('systemId', Value(State, 'systemId'));
        Request.Add('expectedVersion', Value(State, 'version'));
        Request.Add('operation', Operation);
        Request.Add('amount', 7);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure Value(State: JsonObject; Name: Text): Text
    var
        Token: JsonToken;
    begin
        State.Get(Name, Token);
        exit(Token.AsValue().AsText());
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    var
        Probe: Codeunit "BCD Conflict Probe";
        Assert: Codeunit "Library Assert";
}
